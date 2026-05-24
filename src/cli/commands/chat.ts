import * as readline from 'readline';
import chalk from 'chalk';
import boxen from 'boxen';
import { createRequire } from 'module';
import { logger } from '../../utils/logger.js';
const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../../../package.json') as { version: string };
import { loadConfig, getApiKey, setConfigValue } from '../../core/config.js';
import { initClient } from '../../core/api.js';
import type { Message, Tool, DeepSeekClient } from '../../core/api.js';
import { collectProjectContext, contextToSystemPrompt, loadContextDocument } from '../../core/context.js';
import type { ProjectContext } from '../../core/context.js';
import { createSession, saveSession, loadSession, listSessions } from '../../core/session.js';
import { readProjectFile, writeProjectFile, renderDiff } from '../../core/file-manager.js';
import { getDiff } from '../../utils/git.js';
import { initMcp } from '../../core/mcp.js';
import type { McpManager } from '../../core/mcp.js';
import { mergeBundledServers } from '../../core/bundled-mcp.js';
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
        properties: { path: { type: 'string', description: 'Relative path to the file' } },
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
          pattern: { type: 'string', description: 'Glob pattern' },
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
          query: { type: 'string', description: 'Search query' },
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
        properties: { base: { type: 'string', description: 'Base branch (default: HEAD)' } },
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
        return content.slice(0, 200_000);
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

function printHeader(projectName: string, model: string, apiKey: string): void {
  const keyStatus = apiKey
    ? chalk.green('●') + chalk.gray(` ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`)
    : chalk.red('● key missing');

  const line1 = chalk.bold.cyan('didev') + chalk.gray(` v${PKG_VERSION}`) +
    chalk.gray('  ·  ') + chalk.white(projectName) +
    chalk.gray('  ·  ') + chalk.yellow(model) +
    chalk.gray('  ·  ') + keyStatus;

  console.log('\n' + line1);
  console.log(chalk.gray('─'.repeat(60)));
}

function printMcpStatus(mcp: McpManager, servers: import('../../core/config.js').McpServerConfig[]): void {
  if (servers.length === 0) return;

  const statuses = mcp.getServerStatuses();
  if (statuses.length === 0) return;

  const parts: string[] = [];
  for (const s of statuses) {
    if (s.status === 'connected') {
      parts.push(chalk.green('●') + chalk.white(` ${s.name}`) + chalk.dim(` (${s.toolCount})`));
    } else if (s.status === 'failed') {
      parts.push(chalk.red('✕') + chalk.gray(` ${s.name}`));
    } else {
      parts.push(chalk.gray('○') + chalk.gray(` ${s.name}`));
    }
  }

  const connected = statuses.filter(s => s.status === 'connected').length;
  const total = statuses.length;
  const label = chalk.dim('MCP') + chalk.gray(` ${connected}/${total}  `);
  console.log(label + parts.join(chalk.gray('  ·  ')));
  console.log(chalk.gray('─'.repeat(60)));
}

const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  'deepseek-v4-flash':   1_000_000,
  'deepseek-chat':         128_000,
  'deepseek-reasoner':      64_000,
  'deepseek-v4-pro':        64_000,
};

function getContextWindow(model: string): number {
  if (MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];
  if (model.includes('flash'))    return 1_000_000;
  if (model.includes('reasoner')) return 64_000;
  return 128_000;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function printTokenUsage(usage: { promptTokens: number; completionTokens: number; cacheHitTokens?: number; cacheMissTokens?: number }, model: string): void {
  const ctx = getContextWindow(model);
  const pct = (usage.promptTokens / ctx) * 100;
  const bar = buildUsageBar(pct, 20);
  const color = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;

  let cacheInfo = '';
  if (usage.cacheHitTokens !== undefined && usage.promptTokens > 0) {
    const hitPct = Math.round((usage.cacheHitTokens / usage.promptTokens) * 100);
    cacheInfo = chalk.dim(`  ⚡ cache ${hitPct}%`);
  }

  console.log(
    chalk.gray('  ctx ') +
    color(bar) +
    chalk.gray(` ${formatTokens(usage.promptTokens)}/${formatTokens(ctx)}`) +
    chalk.dim(`  +${formatTokens(usage.completionTokens)} out`) +
    cacheInfo
  );
}

function buildUsageBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function printHelp(): void {
  const cmds: [string, string][] = [
    ['/menu',           'открыть интерактивное меню (MCP, модель, контекст...)'],
    ['/agent <task>',   'запустить agent pipeline (Analyst→Architect→Dev→Review)'],
    ['/review',         'code review изменённых файлов'],
    ['/refactor [hint]','AI-рефакторинг кода'],
    ['/apply',          'применить отложенные изменения файлов'],
    ['/files',          'показать файлы в контексте и ожидающие запись'],
    ['/add <file>',     'добавить файл в контекст'],
    ['/context',        'показать базу знаний проекта'],
    ['/context update', 'обновить базу знаний через AI'],
    ['/sessions',       'список сохранённых сессий'],
    ['/save <name>',    'сохранить текущую сессию'],
    ['/load <name>',    'загрузить сессию'],
    ['/config [k=v]',   'показать конфиг или установить значение'],
    ['/clear',          'очистить историю диалога'],
    ['/help',           'показать эту справку'],
    ['/exit',           'выход'],
  ];
  console.log('\n' + chalk.bold('Доступные команды:'));
  for (const [cmd, desc] of cmds) {
    console.log('  ' + chalk.cyan(cmd.padEnd(22)) + chalk.gray(desc));
  }
  console.log('');
  console.log(chalk.gray('  Или просто пишите — и AI ответит.'));
  console.log('');
}

async function promptApplyChanges(
  pendingWrites: Map<string, string>,
  rootDir: string,
  rl: readline.Interface,
  onAutoApply: () => void
): Promise<string[]> {
  if (pendingWrites.size === 0) {
    logger.info('Нет ожидающих изменений');
    return [];
  }
  const appliedFiles: string[] = [];

  // Build file list for box
  const fileLines: string[] = [];
  for (const [filePath, content] of pendingWrites) {
    const original = await readProjectFile(filePath, rootDir).catch(() => '');
    const isNew = !original;
    const lines = content.split('\n').length;
    const tag = isNew ? chalk.green('+') : chalk.yellow('~');
    const label = isNew ? chalk.green('новый') : chalk.yellow('изменён');
    fileLines.push(`  ${tag} ${chalk.white(filePath)}  ${chalk.gray(`${lines} стр · ${label}`)}`);
  }

  console.log('');
  console.log(
    boxen(
      chalk.bold.yellow(`✏️  Подготовлено ${pendingWrites.size} файл(а)`) + '\n\n' +
      fileLines.join('\n'),
      { padding: { top: 0, bottom: 0, left: 1, right: 2 }, borderColor: 'yellow', borderStyle: 'round' }
    )
  );

  // Use rl.question() — same readline session, no raw-mode conflict with Git Bash
  const hint =
    chalk.bold('  [Enter/y]') + chalk.green(' Применить') +
    chalk.bold('  [d]') + chalk.cyan(' Diff') +
    chalk.bold('  [n]') + chalk.red(' Отклонить') +
    chalk.bold('  [a]') + chalk.yellow(' Авто-режим');
  console.log(hint + '\n');

  const answer = await new Promise<string>(resolve => {
    rl.question(chalk.gray('  ▸ '), ans => resolve(ans.trim().toLowerCase()));
  });

  const choice = answer || 'y';

  if (choice === 'n') {
    pendingWrites.clear();
    console.log(chalk.dim('  Изменения отклонены'));

  } else if (choice === 'd') {
    for (const [filePath, content] of pendingWrites) {
      const original = await readProjectFile(filePath, rootDir).catch(() => '');
      console.log('');
      logger.bold(`── ${filePath} ──`);
      console.log(renderDiff(filePath, original, content));
    }
    for (const [filePath, content] of pendingWrites) {
      await writeProjectFile(filePath, content, rootDir);
      appliedFiles.push(filePath);
      console.log(`  ${chalk.green('✓')} ${filePath}`);
    }
    pendingWrites.clear();

  } else {
    if (choice === 'a') {
      onAutoApply();
      console.log(chalk.yellow('  ⚡ Авто-режим включён — все файлы в этом сеансе применяются сразу'));
    }
    for (const [filePath, content] of pendingWrites) {
      await writeProjectFile(filePath, content, rootDir);
      appliedFiles.push(filePath);
      console.log(`  ${chalk.green('✓')} ${filePath}`);
    }
    pendingWrites.clear();
  }
  console.log('');
  return appliedFiles;
}

async function showPostApplyPrompt(
  appliedFiles: string[],
  rl: readline.Interface,
  client: DeepSeekClient,
  model: string,
  projectCtx: ProjectContext,
  rootDir: string,
  contextDocument?: string
): Promise<void> {
  const hint =
    chalk.bold('  [t]') + chalk.cyan(' Написать тесты') +
    chalk.gray('  ·  ') +
    chalk.bold('[r]') + chalk.yellow(' Code review') +
    chalk.gray('  ·  ') +
    chalk.bold('[Enter]') + chalk.gray(' Продолжить');
  console.log(hint + '\n');

  const answer = await new Promise<string>(resolve => {
    rl.question(chalk.gray('  ▸ '), ans => resolve(ans.trim().toLowerCase()));
  });

  if (!answer || (answer !== 't' && answer !== 'r')) return;

  const { TesterAgent } = await import('../../agents/tester.js');
  const { ReviewerAgent } = await import('../../agents/reviewer.js');

  const agent = answer === 't' ? new TesterAgent() : new ReviewerAgent();
  const fileList = appliedFiles.join(', ');
  const task = answer === 't'
    ? `Write tests for the following changed files: ${fileList}`
    : `Review the following changed files: ${fileList}`;

  const result = await agent.run({
    client,
    model,
    projectContext: projectCtx,
    rootDir,
    task,
    dryRun: true,
    contextDocument,
  });

  if (result.pendingWrites.size > 0) {
    const flat = new Map([...result.pendingWrites.entries()].map(([k, v]) => [k, v.content]));
    await promptApplyChanges(flat, rootDir, rl, () => {});
  }
}

export async function runChat(options: ChatOptions = {}): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);

  if (!apiKey) {
    logger.error('API ключ не установлен. Выполните: didev config set DEEPSEEK_API_KEY=sk-xxx');
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
  let model = options.model ?? config.api.model;
  const contextDoc = await loadContextDocument(rootDir);

  let systemPrompt = `You are didev, an expert AI coding assistant integrated with the developer's project.
You have access to tools to read files, search code, and make changes.

${contextToSystemPrompt(projectCtx)}
${contextDoc ? `\n## Project Knowledge Base\n${contextDoc}` : ''}

Guidelines:
- Be concise and practical
- When making file changes, use the write_file tool
- Always show what you're changing and why
- Use the project's existing patterns and conventions`;

  if (options.file) {
    try {
      const content = await readProjectFile(options.file, rootDir);
      systemPrompt += `\n\n## Current File: ${options.file}\n\`\`\`\n${content.slice(0, 400_000)}\n\`\`\``;
    } catch {
      logger.warn(`Не удалось прочитать файл: ${options.file}`);
    }
  }

  const mcpServers = mergeBundledServers(config.mcp?.servers ?? []);
  const mcp = await initMcp(mcpServers);
  const mcpTools = mcp.tools;

  const allTools: Tool[] = [...TOOLS, ...mcpTools];
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];
  const contextFiles: string[] = options.file ? [options.file] : [];
  const pendingWrites = new Map<string, string>();

  let autoApply = false;

  let session = createSession('chat', { model });
  session.messages = messages;
  session.contextFiles = contextFiles;

  // ── Header ──
  printHeader(projectCtx.name, model, apiKey);
  printMcpStatus(mcp, mcpServers);
  console.log(chalk.gray('  Введите сообщение или /help для справки. /exit для выхода.\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = chalk.cyan('you') + chalk.gray(' › ');
  const askQuestion = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('closed'));
      rl.once('close', onClose);
      rl.question(prompt, (answer) => {
        rl.removeListener('close', onClose);
        resolve(answer);
      });
    });

  while (true) {
    let input: string;
    try {
      input = await askQuestion();
    } catch {
      break;
    }

    input = input.trim();
    if (!input) continue;

    // ── Slash commands ──────────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const cmd = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
      const arg = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

      switch (cmd) {

        // ── menu ──
        case 'menu': {
          rl.pause();
          try {
            const { runMenu } = await import('./menu.js');
            const result = await runMenu(true); // inChat = true

            if (result.action === 'exit') {
              rl.close();
              return;
            }

            if (result.action === 'agent' && result.agentTask) {
              try {
                const { runOrchestration } = await import('../../agents/orchestrator.js');
                await runOrchestration({
                  task: result.agentTask,
                  rootDir,
                  model,
                  mode: result.agentMode,
                  skipAgents: result.agentSkip,
                });
              } catch (e) {
                logger.error(`Agent pipeline: ${(e as Error).message}`);
              }
            }

            // If model changed in menu — reload from config
            if (result.action === 'back' || result.action === 'chat') {
              const newConfig = await (await import('../../core/config.js')).loadConfig();
              if (newConfig.api.model !== model) {
                model = newConfig.api.model;
                logger.success(`Модель обновлена: ${chalk.bold(model)}`);
              }
            }
          } catch (e) {
            logger.error(`Menu: ${(e as Error).message}`);
          } finally {
            rl.resume();
          }
          continue;
        }

        // ── exit ──
        case 'exit':
        case 'quit':
          logger.dim('До свидания!');
          rl.close();
          return;

        // ── help ──
        case 'help':
          printHelp();
          continue;

        // ── agent ──
        case 'agent': {
          const task = arg || ((await inquirer.prompt([{
            type: 'input',
            name: 'task',
            message: 'Задача для агентов:',
            validate: (v: string) => v.trim().length > 0 || 'Введите задачу',
          }])) as { task: string }).task;
          if (!task?.trim()) continue;

          rl.pause();
          try {
            const { runOrchestration } = await import('../../agents/orchestrator.js');
            await runOrchestration({ task: task.trim(), rootDir, model });
          } catch (e) {
            logger.error(`Agent pipeline завершился с ошибкой: ${(e as Error).message}`);
          } finally {
            rl.resume();
          }
          continue;
        }

        // ── review ──
        case 'review': {
          rl.pause();
          try {
            const { runReview } = await import('./review.js');
            await runReview({ file: arg || undefined, model });
          } catch (e) {
            logger.error(`Review завершился с ошибкой: ${(e as Error).message}`);
          } finally {
            rl.resume();
          }
          continue;
        }

        // ── refactor ──
        case 'refactor': {
          rl.pause();
          try {
            const { runRefactor } = await import('./refactor.js');
            await runRefactor(arg || undefined, { model, dryRun: true });
          } catch (e) {
            logger.error(`Refactor завершился с ошибкой: ${(e as Error).message}`);
          } finally {
            rl.resume();
          }
          continue;
        }

        // ── config ──
        case 'config': {
          if (arg) {
            // didev config set KEY=VALUE inline
            try {
              const eqIdx = arg.indexOf('=');
              if (eqIdx === -1) {
                logger.warn('Использование: /config KEY=VALUE');
              } else {
                const key = arg.slice(0, eqIdx).trim();
                const value = arg.slice(eqIdx + 1).trim();
                await setConfigValue(key, value);
                logger.success(`Установлено: ${key} = ${key.toLowerCase().includes('key') ? '***' : value}`);
              }
            } catch (e) {
              logger.error((e as Error).message);
            }
          } else {
            const { runConfigShow } = await import('./config.js');
            await runConfigShow();
          }
          continue;
        }

        // ── files ──
        case 'files':
          console.log('');
          if (contextFiles.length === 0) {
            logger.dim('  Нет файлов в контексте');
          } else {
            logger.info(`Файлы в контексте (${contextFiles.length}):`);
            contextFiles.forEach(f => logger.dim(`  ${f}`));
          }
          if (pendingWrites.size > 0) {
            console.log('');
            logger.warn(`Ожидают записи (${pendingWrites.size}): используйте /apply`);
            for (const p of pendingWrites.keys()) logger.dim(`  ${p}`);
          }
          console.log('');
          continue;

        // ── context ──
        case 'context': {
          if (arg === 'update') {
            rl.pause();
            try {
              const { runContextUpdate } = await import('./context.js');
              await runContextUpdate({ model });
              // Reload context doc into system prompt
              const newDoc = await loadContextDocument(rootDir);
              if (newDoc) {
                const cur = messages[0].content ?? '';
                messages[0].content = cur.replace(
                  /\n## Project Knowledge Base\n[\s\S]*?(?=\n\nGuidelines:|\n\nGuidelines:)/,
                  `\n## Project Knowledge Base\n${newDoc}`
                );
                if (!(messages[0].content ?? '').includes('## Project Knowledge Base')) {
                  messages[0].content = (messages[0].content ?? '').replace(
                    '\n\nGuidelines:',
                    `\n\n## Project Knowledge Base\n${newDoc}\n\nGuidelines:`
                  );
                }
                logger.success('База знаний перезагружена в текущую сессию');
              }
            } catch (e) {
              logger.error(`Ошибка обновления: ${(e as Error).message}`);
            } finally {
              rl.resume();
            }
          } else {
            const { runContextShow } = await import('./context.js');
            await runContextShow();
          }
          continue;
        }

        // ── add ──
        case 'add':
          if (!arg) { logger.warn('Использование: /add <файл>'); continue; }
          try {
            const content = await readProjectFile(arg, rootDir);
            contextFiles.push(arg);
            messages.push({
              role: 'user',
              content: `[Добавлен файл в контекст]\n\`\`\`\n// ${arg}\n${content.slice(0, 200_000)}\n\`\`\``,
            });
            messages.push({ role: 'assistant', content: `Файл ${arg} добавлен в контекст.` });
            logger.success(`Добавлен: ${arg}`);
          } catch (e) {
            logger.error(`Не могу прочитать ${arg}: ${(e as Error).message}`);
          }
          continue;

        // ── apply ──
        case 'apply': {
          const applied = await promptApplyChanges(pendingWrites, rootDir, rl, () => { autoApply = true; });
          if (applied.length > 0) {
            await showPostApplyPrompt(applied, rl, client, model, projectCtx, rootDir, contextDoc ?? undefined);
          }
          continue;
        }

        // ── save ──
        case 'save':
          if (!arg) { logger.warn('Использование: /save <имя>'); continue; }
          session.name = arg;
          session.messages = messages;
          session.contextFiles = contextFiles;
          session.updatedAt = new Date().toISOString();
          await saveSession(session, rootDir);
          logger.success(`Сессия сохранена как "${arg}"`);
          continue;

        // ── load ──
        case 'load': {
          if (!arg) { logger.warn('Использование: /load <имя>'); continue; }
          const loaded = await loadSession(arg, rootDir);
          if (!loaded) { logger.error(`Сессия "${arg}" не найдена`); continue; }
          messages.length = 0;
          messages.push(...loaded.messages);
          contextFiles.length = 0;
          contextFiles.push(...loaded.contextFiles);
          session = loaded;
          logger.success(`Сессия "${arg}" загружена (${loaded.messages.length} сообщений)`);
          continue;
        }

        // ── sessions ──
        case 'sessions': {
          const sessions = await listSessions(rootDir);
          if (sessions.length === 0) {
            logger.info('Нет сохранённых сессий');
          } else {
            console.log('');
            console.log(chalk.bold('  Сессии:'));
            for (const s of sessions) {
              const date = new Date(s.updatedAt).toLocaleString('ru-RU');
              const msgs = s.messages.filter(m => m.role === 'user').length;
              console.log(
                `  ${chalk.cyan(s.name.padEnd(20))} ${chalk.gray(date + '  ')}` +
                chalk.dim(`${msgs} сообщ.`)
              );
            }
            console.log('');
          }
          continue;
        }

        // ── clear ──
        case 'clear':
          messages.length = 1; // keep system prompt
          pendingWrites.clear();
          logger.info('Диалог очищен');
          continue;

        default:
          logger.warn(`Неизвестная команда: /${cmd}  (введите /help)`);
          continue;
      }
    }

    // ── Regular message → streaming API call ───────────────────────────────
    messages.push({ role: 'user', content: input });

    let currentToolLabel = '';
    const spinner = logger.spinner({ text: chalk.gray('Думаю...'), color: 'cyan' }).start();

    rl.pause(); // prevent stray stdin events from closing readline during async work
    try {
      console.log(''); // blank line before response

      const { messages: updatedMsgs, finalContent, usage } = await client.runToolLoopStream(
        messages,
        allTools,
        async (name, args) => {
          if (mcp.isMcpTool(name)) return mcp.call(name, args);
          return executeToolCall(name, args, rootDir, pendingWrites);
        },
        (chunk) => {
          if (spinner.isSpinning) {
            spinner.stop();
            process.stdout.write(chalk.magenta('didev') + chalk.gray(' › ') + chalk.white(chunk));
          } else {
            process.stdout.write(chalk.white(chunk));
          }
        },
        (toolName) => {
          currentToolLabel = toolName;
          spinner.text = chalk.gray(`Использую: ${toolName}...`);
          if (!spinner.isSpinning) spinner.start();
        },
        model,
        { temperature: config.api.temperature },
      );

      // Ensure spinner is stopped and newline is printed
      if (spinner.isSpinning) spinner.stop();
      process.stdout.write('\n');

      if (usage) {
        printTokenUsage(usage, model);
      }
      process.stdout.write('\n');

      // Unused, suppress
      void currentToolLabel;

      // Update messages array in place
      messages.length = 0;
      messages.push(...updatedMsgs);

      if (pendingWrites.size > 0) {
        if (autoApply) {
          console.log('');
          const autoApplied: string[] = [];
          for (const [filePath, content] of pendingWrites) {
            await writeProjectFile(filePath, content, rootDir);
            autoApplied.push(filePath);
            console.log(`  ${chalk.green('✓')} ${filePath}`);
          }
          pendingWrites.clear();
          await showPostApplyPrompt(autoApplied, rl, client, model, projectCtx, rootDir, contextDoc ?? undefined);
        } else {
          const applied = await promptApplyChanges(pendingWrites, rootDir, rl, () => { autoApply = true; });
          if (applied.length > 0) {
            await showPostApplyPrompt(applied, rl, client, model, projectCtx, rootDir, contextDoc ?? undefined);
          }
        }
      }

      // Auto-save session
      if (config.output.saveSessions) {
        session.messages = messages;
        session.contextFiles = contextFiles;
        session.updatedAt = new Date().toISOString();
        await saveSession(session, rootDir).catch(() => { /* non-critical */ });
      }

      void finalContent; // captured via onChunk above
    } catch (e) {
      const errMsg = (e as Error).message;
      if (spinner.isSpinning) spinner.fail(chalk.red('Ошибка: ' + errMsg));
      else console.error('\n' + chalk.red('Ошибка: ' + errMsg));
      // Keep the user message in history so context is not lost on transient errors.
      // Only drop it on definitive API errors (4xx except 429/402 retryable).
      const isHardError = /API error [45]\d\d/.test(errMsg) && !/402|429/.test(errMsg);
      if (isHardError) {
        messages.pop();
      } else {
        console.log(chalk.yellow('  ↩  Ваш запрос сохранён — введите что-нибудь для повторной попытки, или /clear для сброса'));
      }
    } finally {
      rl.resume(); // restore stdin after async work completes
    }
  }

  rl.close();
}
