import * as readline from 'readline';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { loadConfig, getApiKey } from '../../core/config.js';
import { initClient, DeepSeekClient } from '../../core/api.js';
import type { Message, Tool } from '../../core/api.js';
import { collectProjectContext, contextToSystemPrompt, loadFilesForContext } from '../../core/context.js';
import { createSession, saveSession, loadSession, listSessions } from '../../core/session.js';
import { readProjectFile, writeProjectFile, listDirectory, extractFileChanges, renderDiff } from '../../core/file-manager.js';
import { getChangedFiles, getDiff } from '../../utils/git.js';
import { initMcp } from '../../core/mcp.js';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { join } from 'path';
import inquirer from 'inquirer';

export interface ChatOptions {
  model?: string;
  file?: string;
}

const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the project',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or update a file in the project (requires user confirmation)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: ".")' },
          pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search for text/pattern in project files',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query or regex' },
          glob: { type: 'string', description: 'File pattern to search in' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Get git diff of changes',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Base branch (default: HEAD)' },
        },
        required: [],
      },
    },
  },
];

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  rootDir: string,
  pendingWrites: Map<string, string>
): Promise<string> {
  switch (name) {
    case 'read_file': {
      try {
        const content = await readProjectFile(String(args['path']), rootDir);
        return content.slice(0, 200_000); // ~50K tokens — well within 1M context
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    }

    case 'write_file': {
      const path = String(args['path']);
      const content = String(args['content']);
      pendingWrites.set(path, content);
      return `File ${path} queued for writing. Use /apply to confirm changes.`;
    }

    case 'list_files': {
      const pattern = String(args['pattern'] ?? '**/*');
      const dir = String(args['path'] ?? '.');
      try {
        const files = await glob(pattern === '**/*' ? `${dir}/**/*` : pattern, {
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
      const pattern = String(args['glob'] ?? '**/*.{ts,tsx,js,jsx,py,go}');
      try {
        const files = await glob(pattern, {
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
              }
            }
          } catch { /* skip */ }
        }
        return results.slice(0, 50).join('\n') || 'No matches found';
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
        return `Error: ${(e as Error).message}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

export async function runChat(options: ChatOptions = {}): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);

  if (!apiKey) {
    logger.error('DEEPSEEK_API_KEY not set. Run: didev config set DEEPSEEK_API_KEY=sk-xxx');
    process.exit(1);
  }

  const client = initClient({
    apiKey,
    baseUrl: config.api.baseUrl,
    model: options.model ?? config.api.model,
    maxTokens: config.api.maxTokens,
    temperature: config.api.temperature,
  });

  const rootDir = process.cwd();
  const projectCtx = await collectProjectContext(rootDir);
  const model = options.model ?? config.api.model;

  // Build system prompt
  let systemPrompt = `You are didev, an expert AI coding assistant integrated with the developer's project.
You have access to tools to read files, search code, and make changes.

${contextToSystemPrompt(projectCtx)}

Guidelines:
- Be concise and practical
- When making file changes, use the write_file tool
- Always show what you're changing and why
- Use the project's existing patterns and conventions`;

  // Add specific file context if requested
  if (options.file) {
    try {
      const content = await readProjectFile(options.file, rootDir);
      systemPrompt += `\n\n## Current File: ${options.file}\n\`\`\`\n${content.slice(0, 400_000)}\n\`\`\``;
    } catch (e) {
      logger.warn(`Could not read file: ${options.file}`);
    }
  }

  // Initialize MCP servers
  const mcp = await initMcp(config.mcp?.servers ?? []);
  const mcpTools = mcp.tools;
  if (mcpTools.length > 0) {
    logger.success(`MCP: ${mcpTools.length} tool(s) from ${mcp.summary().length} server(s)`);
  }

  const allTools: Tool[] = [...TOOLS, ...mcpTools];

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  const contextFiles: string[] = options.file ? [options.file] : [];
  const pendingWrites = new Map<string, string>();

  let session = createSession('chat', { model });
  session.messages = messages;
  session.contextFiles = contextFiles;

  // Display banner
  logger.banner(`didev chat`, `${chalk.gray(model)} • ${chalk.gray(projectCtx.name)}`);
  logger.dim('Commands: /files, /add <file>, /apply, /save <name>, /load <name>, /clear, /exit');
  logger.dim('Type your message and press Enter to chat.');
  logger.newline();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = chalk.cyan('you') + chalk.gray(' › ');

  const askQuestion = (): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  while (true) {
    let input: string;
    try {
      input = await askQuestion();
    } catch {
      break;
    }

    input = input.trim();
    if (!input) continue;

    // Handle slash commands
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(' ');
      const arg = args.join(' ').trim();

      switch (cmd) {
        case 'exit':
        case 'quit':
          logger.dim('Goodbye!');
          rl.close();
          return;

        case 'files':
          logger.info(`Context files (${contextFiles.length}):`);
          if (contextFiles.length === 0) logger.dim('  No files in context');
          else contextFiles.forEach(f => logger.dim(`  ${f}`));
          if (pendingWrites.size > 0) {
            logger.warn(`Pending writes (${pendingWrites.size}): use /apply to confirm`);
            for (const p of pendingWrites.keys()) logger.dim(`  ${p}`);
          }
          continue;

        case 'add':
          if (!arg) { logger.warn('Usage: /add <file>'); continue; }
          try {
            const content = await readProjectFile(arg, rootDir);
            contextFiles.push(arg);
            messages.push({
              role: 'user',
              content: `[Added file context]\n\`\`\`\n// ${arg}\n${content.slice(0, 200_000)}\n\`\`\``,
            });
            messages.push({ role: 'assistant', content: `I've read ${arg} and added it to my context.` });
            logger.success(`Added ${arg} to context`);
          } catch (e) {
            logger.error(`Cannot read ${arg}: ${(e as Error).message}`);
          }
          continue;

        case 'apply':
          if (pendingWrites.size === 0) {
            logger.info('No pending file changes');
            continue;
          }
          for (const [filePath, content] of pendingWrites) {
            try {
              const original = await readProjectFile(filePath, rootDir).catch(() => '');
              logger.newline();
              logger.bold(`File: ${filePath}`);
              console.log(renderDiff(filePath, original, content));
            } catch { /* new file */ }
          }
          const { confirm } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Apply ${pendingWrites.size} file change(s)?`,
            default: true,
          }]);
          if (confirm) {
            for (const [filePath, content] of pendingWrites) {
              await writeProjectFile(filePath, content, rootDir);
              logger.success(`Written: ${filePath}`);
            }
            pendingWrites.clear();
          } else {
            logger.info('Changes not applied');
          }
          continue;

        case 'save':
          if (!arg) { logger.warn('Usage: /save <name>'); continue; }
          session.name = arg;
          session.messages = messages;
          session.contextFiles = contextFiles;
          session.updatedAt = new Date().toISOString();
          await saveSession(session, rootDir);
          logger.success(`Session saved as "${arg}"`);
          continue;

        case 'load':
          if (!arg) { logger.warn('Usage: /load <name>'); continue; }
          const loaded = await loadSession(arg, rootDir);
          if (!loaded) { logger.error(`Session "${arg}" not found`); continue; }
          messages.length = 0;
          messages.push(...loaded.messages);
          contextFiles.length = 0;
          contextFiles.push(...loaded.contextFiles);
          session = loaded;
          logger.success(`Session "${arg}" loaded (${loaded.messages.length} messages)`);
          continue;

        case 'clear':
          messages.length = 1; // keep system prompt
          pendingWrites.clear();
          logger.info('Conversation cleared');
          continue;

        case 'sessions':
          const sessions = await listSessions(rootDir);
          if (sessions.length === 0) logger.info('No saved sessions');
          else sessions.forEach(s => logger.dim(`  ${s.name} — ${new Date(s.updatedAt).toLocaleDateString()}`));
          continue;

        default:
          logger.warn(`Unknown command: /${cmd}`);
          continue;
      }
    }

    // Regular message — call API with tools
    messages.push({ role: 'user', content: input });

    const spinner = logger.spinner({ text: chalk.gray('Thinking...'), color: 'cyan' }).start();

    try {
      const { messages: updatedMsgs, finalContent } = await client.runToolLoop(
        messages,
        allTools,
        async (name, args) => {
          if (mcp.isMcpTool(name)) return mcp.call(name, args);
          return executeToolCall(name, args, rootDir, pendingWrites);
        },
        model,
        { temperature: config.api.temperature },
      );

      spinner.stop();

      // Update messages array in place
      messages.length = 0;
      messages.push(...updatedMsgs);

      // Display response
      logger.newline();
      console.log(chalk.magenta('didev') + chalk.gray(' › '));
      console.log(chalk.white(finalContent));
      logger.newline();

      if (pendingWrites.size > 0) {
        logger.warn(`${pendingWrites.size} file(s) ready to write. Use /apply to confirm.`);
      }

      // Auto-save session
      if (config.output.saveSessions) {
        session.messages = messages;
        session.contextFiles = contextFiles;
        session.updatedAt = new Date().toISOString();
        await saveSession(session, rootDir).catch(() => { /* non-critical */ });
      }
    } catch (e) {
      spinner.fail(chalk.red('Error: ' + (e as Error).message));
      messages.pop(); // remove failed user message
    }
  }

  rl.close();
}
