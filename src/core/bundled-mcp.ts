import { join } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import type { McpServerConfig } from './mcp.js';

export interface RequiredEnvVar {
  name: string;
  hint: string;
  sensitive: boolean;
}

export interface BundledServerDef {
  name: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  requiresAuth: boolean;
  requiredEnv: RequiredEnvVar[];
  gitRepo?: string;            // clone URL for GitHub-based servers
  defaultEnabled: boolean;
}

const MCP_DIR = join(homedir(), '.didev', 'mcp');

export const BUNDLED_SERVERS: BundledServerDef[] = [
  {
    name: 'java-vuln',
    displayName: 'Java Vuln Remediation',
    description: 'Find vulnerable Java deps via OSV.dev + Maven Central',
    command: 'node',
    args: [join(MCP_DIR, 'java-vuln-remediation', 'dist', 'index.js')],
    requiresAuth: false,
    requiredEnv: [],
    gitRepo: 'https://github.com/Neovaryag/java-vuln-remediation.git',
    defaultEnabled: true,
  },
  {
    name: 'context7',
    displayName: 'Context7',
    description: 'Real-time library documentation from context7.com',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    requiresAuth: false,
    requiredEnv: [],
    defaultEnabled: true,
  },
  {
    name: 'pgs-tool',
    displayName: 'PostgreSQL Tool',
    description: 'PostgreSQL MCP tools for database interaction',
    command: 'node',
    args: [join(MCP_DIR, 'mcp-pgs-tool', 'dist', 'index.js')],
    env: { DATABASE_URL: '${DATABASE_URL}' },
    requiresAuth: true,
    requiredEnv: [
      { name: 'DATABASE_URL', hint: 'postgresql://user:pass@host/dbname', sensitive: false },
    ],
    gitRepo: 'https://github.com/Neovaryag/mcp-pgs-tool.git',
    defaultEnabled: false,
  },
  {
    name: 'atlassian',
    displayName: 'Atlassian MCP',
    description: 'Jira & Confluence integration',
    command: 'node',
    args: [join(MCP_DIR, 'atlassian-mcp', 'dist', 'index.js')],
    env: {
      ATLASSIAN_API_TOKEN: '${ATLASSIAN_API_TOKEN}',
      ATLASSIAN_BASE_URL: '${ATLASSIAN_BASE_URL}',
      ATLASSIAN_EMAIL: '${ATLASSIAN_EMAIL}',
    },
    requiresAuth: true,
    requiredEnv: [
      { name: 'ATLASSIAN_EMAIL',     hint: 'your@email.com',                sensitive: false },
      { name: 'ATLASSIAN_API_TOKEN', hint: 'your Atlassian API token',       sensitive: true  },
      { name: 'ATLASSIAN_BASE_URL',  hint: 'https://yourcompany.atlassian.net', sensitive: false },
    ],
    gitRepo: 'https://github.com/varunkumar/atlassian-mcp.git',
    defaultEnabled: false,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toBundledMcpConfig(def: BundledServerDef): McpServerConfig {
  return {
    name: def.name,
    command: def.command,
    args: def.args,
    ...(def.env ? { env: def.env } : {}),
    enabled: resolveEnabled(def),
  };
}

function resolveEnabled(def: BundledServerDef): boolean {
  if (!def.defaultEnabled) return false;
  // If it requires env vars that aren't set, disable it
  const missing = getMissingRequiredEnv(def);
  if (missing.length > 0) return false;
  return true;
}

export function getMissingRequiredEnv(def: BundledServerDef): string[] {
  return def.requiredEnv
    .filter(e => !process.env[e.name])
    .map(e => e.name);
}

// Returns true if the server entry point file exists (for node-based cloned servers)
export async function isBundledServerReady(def: BundledServerDef): Promise<boolean> {
  if (def.command === 'npx') return true;
  const entryPoint = def.args[0];
  if (!entryPoint) return false;
  try {
    await access(entryPoint);
    return true;
  } catch {
    return false;
  }
}

// Merges bundled servers into an existing list — skips ones already present by name
export function mergeBundledServers(existing: McpServerConfig[]): McpServerConfig[] {
  const names = new Set(existing.map(s => s.name));
  const result = [...existing];
  for (const def of BUNDLED_SERVERS) {
    if (!names.has(def.name)) {
      result.push(toBundledMcpConfig(def));
    }
  }
  return result;
}
