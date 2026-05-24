import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from './api.js';
import { logger } from '../utils/logger.js';
import { withTimeout } from '../utils/resilience.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export type McpConnectionStatus = 'connected' | 'failed' | 'disabled' | 'skipped';

export interface McpServerStatus {
  name: string;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
}

// MCP tool with server attribution, compatible with DeepSeek Tool format
export interface McpTool extends Tool {
  _mcpServer: string;
  _mcpOriginalName: string;
}

interface ToolEntry {
  client: Client;
  originalName: string;
  serverName: string;
}

export class McpManager {
  private clients = new Map<string, Client>();
  private toolEntries = new Map<string, ToolEntry>(); // qualifiedName → entry
  private mcpTools: McpTool[] = [];
  private serverStatuses = new Map<string, McpServerStatus>();

  get tools(): McpTool[] {
    return this.mcpTools;
  }

  get isConnected(): boolean {
    return this.clients.size > 0;
  }

  // Connect to all enabled servers. Non-fatal: logs warnings on failure.
  async connectAll(servers: McpServerConfig[]): Promise<void> {
    // Track disabled servers immediately
    for (const s of servers) {
      if (s.enabled === false) {
        this.serverStatuses.set(s.name, { name: s.name, status: 'disabled', toolCount: 0 });
      }
    }

    const enabled = servers.filter(s => s.enabled !== false);
    if (enabled.length === 0) return;

    await Promise.allSettled(
      enabled.map(s => this.connectOne(s))
    );
  }

  getServerStatuses(): McpServerStatus[] {
    return [...this.serverStatuses.values()];
  }

  getServerStatus(name: string): McpServerStatus | undefined {
    return this.serverStatuses.get(name);
  }

  async connectOne(config: McpServerConfig): Promise<void> {
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      // Apply server-specific env, expanding ${VAR} references
      for (const [k, v] of Object.entries(config.env ?? {})) {
        env[k] = v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
      }

      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env,
      });

      const client = new Client(
        { name: 'didev', version: '1.0.0' },
        { capabilities: {} }
      );

      // npx servers may need to download the package on first run — give them 90s
      const isNpx = config.command === 'npx' || config.command === 'npx.cmd';
      const connectTimeout = isNpx ? 90_000 : 20_000;
      if (isNpx) {
        logger.dim(`  ⬇  "${config.name}" — downloading via npx, may take up to 90s on first run...`);
      }

      await withTimeout(client.connect(transport), connectTimeout, `MCP connect "${config.name}"`);
      this.clients.set(config.name, client);

      const { tools } = await withTimeout(client.listTools(), 15_000, `MCP listTools "${config.name}"`);

      for (const tool of tools) {
        const qualifiedName = `${config.name}__${tool.name}`;
        this.toolEntries.set(qualifiedName, {
          client,
          originalName: tool.name,
          serverName: config.name,
        });
        this.mcpTools.push({
          type: 'function',
          function: {
            name: qualifiedName,
            description: `[MCP:${config.name}] ${tool.description ?? tool.name}`,
            parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          },
          _mcpServer: config.name,
          _mcpOriginalName: tool.name,
        });
      }

      this.serverStatuses.set(config.name, {
        name: config.name,
        status: 'connected',
        toolCount: tools.length,
      });
      logger.success(`MCP: "${config.name}" connected — ${tools.length} tool(s)`);
    } catch (e) {
      const errMsg = (e as Error).message;
      this.serverStatuses.set(config.name, {
        name: config.name,
        status: 'failed',
        toolCount: 0,
        error: errMsg,
      });
      logger.warn(`MCP: "${config.name}" failed — ${errMsg}`);
    }
  }

  // Call an MCP tool by qualified name (serverName__toolName)
  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolEntries.get(qualifiedName);
    if (!entry) throw new Error(`MCP tool not found: ${qualifiedName}`);

    logger.debug(`MCP call: ${qualifiedName}(${JSON.stringify(args)})`);

    const result = await withTimeout(
      entry.client.callTool({ name: entry.originalName, arguments: args }),
      30_000,
      `MCP tool "${qualifiedName}"`
    );

    // Flatten mixed content blocks to a string
    const content = Array.isArray(result.content) ? result.content : [];
    return content
      .map((c: { type?: string; text?: string }) =>
        c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)
      )
      .join('\n')
      || '(no output)';
  }

  isMcpTool(name: string): boolean {
    return this.toolEntries.has(name);
  }

  // Return a human-readable summary for didev mcp list
  summary(): Array<{ server: string; tools: string[] }> {
    const map = new Map<string, string[]>();
    for (const [qualName, entry] of this.toolEntries) {
      if (!map.has(entry.serverName)) map.set(entry.serverName, []);
      map.get(entry.serverName)!.push(entry.originalName);
    }
    return [...map.entries()].map(([server, tools]) => ({ server, tools }));
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map(c => c.close())
    );
    this.clients.clear();
    this.toolEntries.clear();
    this.mcpTools = [];
    this.serverStatuses.clear();
  }
}

// Singleton per process — shared between chat and agents in the same session
let _manager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!_manager) _manager = new McpManager();
  return _manager;
}

export async function initMcp(servers: McpServerConfig[]): Promise<McpManager> {
  const mgr = getMcpManager();
  await mgr.connectAll(servers);
  return mgr;
}
