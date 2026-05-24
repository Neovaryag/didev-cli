import chalk from 'chalk';
import { DeepSeekClient, initClient } from '../core/api.js';
import type { Message, Tool, ToolCall } from '../core/api.js';
import { readProjectFile, writeProjectFile, listDirectory } from '../core/file-manager.js';
import type { ProjectContext } from '../core/context.js';
import { contextToSystemPrompt } from '../core/context.js';
import { logger } from '../utils/logger.js';
import { getMcpManager } from '../core/mcp.js';
import { getChangedFiles, getDiff } from '../utils/git.js';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { join } from 'path';

export interface AgentResult {
  agentName: string;
  role: string;
  emoji: string;
  output: string;
  artifacts: AgentArtifact[];
  fileChanges: FileChange[];
  pendingWrites: Map<string, { content: string; description?: string }>;
  duration: number;
}

export interface AgentArtifact {
  type: 'story' | 'spec' | 'architecture' | 'tests' | 'review' | 'analysis' | 'plan';
  title: string;
  content: string;
}

export interface FileChange {
  path: string;
  content: string;
  description?: string;
}

export interface StepInfo {
  current: number;
  total: number;
  parallel?: boolean;
}

export interface AgentOptions {
  client: DeepSeekClient;
  model: string;
  projectContext: ProjectContext;
  rootDir: string;
  task: string;
  previousResults?: AgentResult[];
  maxRounds?: number;
  /** When true, write_file calls are queued in pendingWrites instead of written immediately */
  dryRun?: boolean;
  /** Pre-generated project knowledge base document from .didev/context.md */
  contextDocument?: string;
  /** Position in the pipeline for display */
  stepInfo?: StepInfo;
}

export const AGENT_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read contents of a project file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or update a project file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Complete file content' },
          description: { type: 'string', description: 'What this file does' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. src/**/*.ts)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for text across project files',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for' },
          pattern: { type: 'string', description: 'File pattern to search in' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Get git diff to see recent changes',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base ref (default: HEAD)' },
        },
        required: [],
      },
    },
  },
];

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly role: string;
  abstract readonly emoji: string;
  abstract readonly description: string;
  protected abstract buildSystemPrompt(ctx: ProjectContext, task: string): string;

  protected pendingWrites = new Map<string, { content: string; description?: string }>();

  private toolLabel(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'read_file':       return `📖 Читаю:    ${args['path']}`;
      case 'write_file':      return `✏️  Пишу:     ${args['path']}`;
      case 'list_directory':  return `📂 Смотрю:   ${args['path'] ?? '.'}`;
      case 'search_files':    return `🔍 Ищу:      "${args['query']}"`;
      case 'git_diff':        return `🔀 Git diff`;
      default:                return `⚙️  ${name}`;
    }
  }

  private printStepBanner(stepInfo?: StepInfo): void {
    const step = stepInfo
      ? chalk.bold.white(`Шаг ${stepInfo.current}/${stepInfo.total}`) + (stepInfo.parallel ? chalk.yellow('  ⚡ параллельно') : '')
      : '';
    const divider = chalk.cyan('─'.repeat(54));
    console.log(divider);
    if (step) console.log(`  ${chalk.gray('▶')}  ${step}   ${this.emoji} ${chalk.bold(this.name)}`);
    else      console.log(`  ${this.emoji} ${chalk.bold(this.name)}`);
    console.log(`     ${chalk.dim(this.role)}`);
    console.log(`     ${chalk.dim('↳')} ${chalk.dim(this.description)}`);
    console.log('');
  }

  async run(options: AgentOptions): Promise<AgentResult> {
    const start = Date.now();
    const { client, model, projectContext, rootDir, task, previousResults, dryRun } = options;

    this.printStepBanner(options.stepInfo);

    const spinner = logger.spinner({ text: chalk.gray('Анализирую...'), color: 'magenta' }).start();

    const baseSystemPrompt = this.buildSystemPrompt(projectContext, task);
    const systemPrompt = options.contextDocument
      ? `${baseSystemPrompt}\n\n## Project Knowledge Base\n${options.contextDocument}`
      : baseSystemPrompt;
    const userMessage = this.buildUserMessage(task, previousResults);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    let output = '';
    const fileChanges: FileChange[] = [];
    // In dry-run mode writes go here; otherwise they are applied immediately
    const pendingWrites = new Map<string, { content: string; description?: string }>();

    // Merge built-in agent tools with any connected MCP tools
    const mcp = getMcpManager();
    const allTools: Tool[] = [...AGENT_TOOLS, ...mcp.tools];

    try {
      const { messages: finalMsgs, finalContent } = await client.runToolLoop(
        messages,
        allTools,
        async (name, args) => {
          // Print tool call as persistent line, then restart spinner
          if (spinner.isSpinning) spinner.stop();
          console.log('  ' + chalk.dim(this.toolLabel(name, args)));
          spinner.text = chalk.gray('Думаю...');
          spinner.start();

          if (mcp.isMcpTool(name)) return mcp.call(name, args);
          return this.executeToolCall(name, args, rootDir, fileChanges, dryRun ? pendingWrites : undefined);
        },
        model,
        {
          temperature: 0.3,
          onRetry: (attempt, total, _err) => {
            spinner.text = chalk.yellow(`⟳ Таймаут — повторяю попытку ${attempt}/${total}...`);
            if (!spinner.isSpinning) spinner.start();
          },
        },
        options.maxRounds ?? 10
      );

      output = finalContent ?? '';
      spinner.stop();

      // Display output
      logger.newline();
      console.log(chalk.white(output));
      logger.newline();

      // Show file changes summary (written files)
      if (fileChanges.length > 0) {
        logger.dim(`  Создано/изменено ${fileChanges.length} файл(ов):`);
        for (const fc of fileChanges) {
          logger.step('✓', chalk.green(`  ${fc.path}`) + chalk.gray(fc.description ? ` — ${fc.description}` : ''));
        }
      }

      // Show pending writes summary (dry-run mode)
      if (pendingWrites.size > 0) {
        logger.dim(`  Ожидают записи (dry-run): ${pendingWrites.size} файл(ов)`);
        for (const [path] of pendingWrites) {
          logger.step('○', chalk.yellow(`  ${path}`));
        }
      }

      void finalMsgs;

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        chalk.green('  ✓') + '  ' + this.emoji + ' ' + chalk.bold(this.name) +
        chalk.dim(`  завершён за ${elapsed}s`)
      );
    } catch (e) {
      const msg = (e as Error).message;
      const isTimeout = /timed out|timeout/i.test(msg);
      const display = isTimeout
        ? `${this.name}: превышено время ожидания ответа от DeepSeek (все попытки исчерпаны)`
        : `${this.name}: ${msg}`;
      spinner.fail(chalk.red(display));
      throw e;
    }

    const artifacts = this.extractArtifacts(output);

    return {
      agentName: this.name,
      role: this.role,
      emoji: this.emoji,
      output,
      artifacts,
      fileChanges,
      pendingWrites,
      duration: Date.now() - start,
    };
  }

  protected buildUserMessage(task: string, previousResults?: AgentResult[]): string {
    let msg = `Task: ${task}`;

    if (previousResults && previousResults.length > 0) {
      msg += '\n\n## Previous Agent Outputs\n';
      for (const r of previousResults) {
        msg += `\n### ${r.agentName} (${r.role})\n${r.output.slice(0, 40_000)}\n`;
        if (r.fileChanges.length > 0) {
          msg += `\nFiles created: ${r.fileChanges.map(f => f.path).join(', ')}\n`;
        }
      }
    }

    return msg;
  }

  protected async executeToolCall(
    name: string,
    args: Record<string, unknown>,
    rootDir: string,
    fileChanges: FileChange[],
    pendingWrites?: Map<string, { content: string; description?: string }>
  ): Promise<string> {
    switch (name) {
      case 'read_file': {
        try {
          const content = await readProjectFile(String(args['path']), rootDir);
          return content.slice(0, 400_000);
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      }

      case 'write_file': {
        const path = String(args['path']);
        const content = String(args['content']);
        const description = args['description'] ? String(args['description']) : undefined;

        if (pendingWrites) {
          // Dry-run: queue for later confirmation
          pendingWrites.set(path, { content, description });
          return `File ${path} queued for writing (dry-run mode)`;
        }

        try {
          await writeProjectFile(path, content, rootDir);
          fileChanges.push({ path, content, description });
          return `File ${path} written successfully`;
        } catch (e) {
          return `Error writing ${path}: ${(e as Error).message}`;
        }
      }

      case 'list_files': {
        try {
          const pattern = String(args['pattern'] ?? '**/*');
          const files = await glob(pattern, {
            cwd: rootDir,
            ignore: ['node_modules/**', 'dist/**', '.git/**'],
          });
          return files.slice(0, 100).join('\n') || 'No files found';
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      }

      case 'search_code': {
        const query = String(args['query']);
        const filePattern = String(args['pattern'] ?? '**/*.{ts,tsx,js,jsx,py,go}');
        try {
          const files = await glob(filePattern, {
            cwd: rootDir,
            ignore: ['node_modules/**', 'dist/**', '.git/**'],
          });
          const results: string[] = [];
          for (const f of files.slice(0, 50)) {
            try {
              const content = await readFile(join(rootDir, f), 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(query)) {
                  results.push(`${f}:${i + 1}: ${lines[i].trim()}`);
                  if (results.length >= 50) break;
                }
              }
            } catch { /* skip */ }
          }
          return results.join('\n') || 'No matches found';
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      }

      case 'git_diff': {
        try {
          const base = String(args['base'] ?? 'HEAD');
          const diff = await getDiff(base, rootDir);
          return diff.slice(0, 400_000) || 'No changes';
        } catch (e) {
          return `Git not available or no changes: ${(e as Error).message}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  protected extractArtifacts(output: string): AgentArtifact[] {
    const artifacts: AgentArtifact[] = [];

    // Extract markdown sections as artifacts
    const sections = output.match(/#{1,3}\s+(.+)\n([\s\S]+?)(?=#{1,3}\s|$)/g) ?? [];
    for (const section of sections.slice(0, 5)) {
      const titleMatch = section.match(/#{1,3}\s+(.+)/);
      if (titleMatch) {
        artifacts.push({
          type: 'analysis',
          title: titleMatch[1].trim(),
          content: section,
        });
      }
    }

    return artifacts;
  }
}
