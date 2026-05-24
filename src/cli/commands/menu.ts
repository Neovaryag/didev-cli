import chalk from 'chalk';
import inquirer from 'inquirer';
import { createRequire } from 'module';
import { loadConfig, setConfigValue } from '../../core/config.js';
import type { McpServerConfig } from '../../core/config.js';
import { getMcpManager, initMcp } from '../../core/mcp.js';
import type { McpConnectionStatus } from '../../core/mcp.js';
import { BUNDLED_SERVERS, getMissingRequiredEnv, mergeBundledServers } from '../../core/bundled-mcp.js';
import { logger } from '../../utils/logger.js';

const _require = createRequire(import.meta.url);
const { version: PKG_VERSION } = _require('../../../package.json') as { version: string };

export interface MenuResult {
  action: 'chat' | 'agent' | 'exit' | 'back';
  model?: string;
  agentTask?: string;
  agentMode?: 'full' | 'light' | 'developer-only';
  agentSkip?: string[];
}

const MODELS: { name: string; value: string; desc: string }[] = [
  {
    name: 'deepseek-v4-flash',
    value: 'deepseek-v4-flash',
    desc: 'быстрая · 1M контекст · 384K вывод  (по умолчанию)',
  },
  {
    name: 'deepseek-v4-pro',
    value: 'deepseek-v4-pro',
    desc: 'thinking model · сложные архитектурные задачи',
  },
];

const AGENTS: [string, string][] = [
  ['Analyst',    'анализ задачи и требований'],
  ['Architect',  'архитектура и технический план'],
  ['Developer',  'реализация кода'],
  ['Reviewer',   'code review'],
  ['Tester',     'написание тестов'],
];

function sep(len = 44): inquirer.Separator {
  return new inquirer.Separator(chalk.gray('─'.repeat(len)));
}

function header(projectName: string): void {
  console.log('');
  console.log(
    chalk.bold.cyan('didev') +
    chalk.gray(` v${PKG_VERSION}`) +
    chalk.gray('  ·  ') +
    chalk.white(projectName),
  );
  console.log(chalk.gray('─'.repeat(50)));
  console.log('');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runMenu(inChat = false): Promise<MenuResult> {
  const projectName = process.cwd().split(/[/\\]/).pop() ?? 'project';

  // If MCP was not initialized yet (e.g. bare `didev` or `didev menu`),
  // connect servers now so the status display is accurate.
  const manager = getMcpManager();
  if (!manager.hasBeenInitialized) {
    const config = await loadConfig();
    const servers = mergeBundledServers(config.mcp?.servers ?? []);
    if (servers.some(s => s.enabled !== false)) {
      logger.dim('  Подключаю MCP серверы...');
      await initMcp(servers);
    }
  }

  while (true) {
    const config = await loadConfig();
    const currentModel = config.api.model;
    const servers = config.mcp?.servers ?? [];

    // Show connected count from live manager, fall back to config count
    const statuses = manager.getServerStatuses();
    const connectedCount = statuses.filter(s => s.status === 'connected').length;
    const totalCount = mergeBundledServers(servers).length;
    const mcpLabel = totalCount > 0
      ? chalk.dim(`(${connectedCount}/${totalCount} подключено)`)
      : chalk.dim('(нет)');

    header(projectName);

    const { action } = await inquirer.prompt<{ action: string }>([{
      type: 'list',
      name: 'action',
      message: 'Меню',
      choices: [
        inChat
          ? { name: `${chalk.cyan('▶')}  Вернуться в чат`, value: 'chat' }
          : { name: `${chalk.cyan('▶')}  Чат с AI`, value: 'chat' },
        { name: `${chalk.yellow('◈')}  Агент pipeline`, value: 'agent' },
        sep(),
        { name: `${chalk.blue('◉')}  MCP серверы  ${mcpLabel}`, value: 'mcp' },
        { name: `${chalk.green('◉')}  Контекст проекта`, value: 'context' },
        { name: `${chalk.magenta('◉')}  Модель: ${chalk.bold(currentModel)}`, value: 'model' },
        { name: `${chalk.gray('◉')}  Настройки конфига`, value: 'settings' },
        sep(),
        { name: `${chalk.red('✕')}  Выход`, value: 'exit' },
      ],
      pageSize: 12,
    }]);

    switch (action) {
      case 'chat':
        return { action: inChat ? 'back' : 'chat', model: config.api.model };

      case 'agent': {
        const result = await agentMenu();
        if (result !== null) return result;
        break;
      }

      case 'mcp':
        await mcpMenu(servers);
        break;

      case 'context':
        await contextMenu(config.api.model);
        break;

      case 'model':
        await modelMenu(currentModel);
        break;

      case 'settings':
        await settingsMenu();
        break;

      case 'exit':
        return { action: 'exit' };
    }
    // loop → redraw menu
  }
}

// ── Agents / Skills ───────────────────────────────────────────────────────────

async function agentMenu(): Promise<MenuResult | null> {
  console.log('');
  console.log(chalk.bold('  Skills — доступные агенты:'));
  console.log('');
  for (const [name, desc] of AGENTS) {
    console.log(`  ${chalk.cyan(name.padEnd(12))}${chalk.gray(desc)}`);
  }
  console.log('');

  const { choice } = await inquirer.prompt<{ choice: string }>([{
    type: 'list',
    name: 'choice',
    message: 'Режим запуска',
    choices: [
      { name: 'Полный pipeline  (Analyst → Architect → Developer → Reviewer)', value: 'full' },
      { name: 'Только Developer', value: 'dev' },
      { name: 'Только Reviewer', value: 'review' },
      { name: 'Только Tester', value: 'tester' },
      sep(),
      { name: chalk.gray('Назад'), value: 'back' },
    ],
  }]);

  if (choice === 'back') return null;

  const { task } = await inquirer.prompt<{ task: string }>([{
    type: 'input',
    name: 'task',
    message: 'Опишите задачу:',
    validate: (v: string) => v.trim().length > 0 || 'Введите задачу',
  }]);

  if (!task?.trim()) return null;

  const SKIP_ALL_BUT_DEV = ['Analyst', 'Frontend Analyst', 'Backend Analyst', 'Architect', 'Frontend Architect', 'Backend Architect', 'Reviewer', 'Security Auditor', 'Tester', 'Performance Auditor'];
  const SKIP_ALL_BUT_REVIEW = ['Analyst', 'Frontend Analyst', 'Backend Analyst', 'Architect', 'Frontend Architect', 'Backend Architect', 'Developer', 'Frontend Developer', 'Backend Developer', 'Tester', 'Performance Auditor'];
  const SKIP_ALL_BUT_TEST   = ['Analyst', 'Frontend Analyst', 'Backend Analyst', 'Architect', 'Frontend Architect', 'Backend Architect', 'Developer', 'Frontend Developer', 'Backend Developer', 'Reviewer', 'Security Auditor'];

  const modeMap: Record<string, { agentMode?: MenuResult['agentMode']; agentSkip?: string[] }> = {
    full:    { agentMode: 'full' },
    dev:     { agentMode: 'developer-only' },
    review:  { agentSkip: SKIP_ALL_BUT_REVIEW },
    tester:  { agentSkip: SKIP_ALL_BUT_TEST },
  };

  return { action: 'agent', agentTask: task.trim(), ...modeMap[choice] };
}

// ── MCP ───────────────────────────────────────────────────────────────────────

function mcpStatusIcon(status: McpConnectionStatus | 'unknown'): string {
  switch (status) {
    case 'connected': return chalk.green('●');
    case 'failed':    return chalk.red('✕');
    case 'disabled':  return chalk.gray('○');
    default:          return chalk.dim('·');
  }
}

async function mcpMenu(servers: McpServerConfig[]): Promise<void> {
  console.log('');

  // Merge bundled to get the full picture even if config doesn't have them yet
  const allServers = mergeBundledServers(servers);
  const manager = getMcpManager();
  const liveStatuses = manager.getServerStatuses();
  const statusMap = new Map(liveStatuses.map(s => [s.name, s]));

  // Build display rows
  console.log(chalk.bold(`  MCP серверы (${allServers.length}):`));
  console.log('');

  for (const s of allServers) {
    const live = statusMap.get(s.name);
    const status = live?.status ?? (s.enabled === false ? 'disabled' : 'unknown');
    const icon = mcpStatusIcon(status);

    // Status label
    let statusLabel: string;
    if (status === 'connected') {
      statusLabel = chalk.green(`подключён  (${live!.toolCount} tools)`);
    } else if (status === 'failed') {
      const shortErr = (live?.error ?? '').slice(0, 40);
      statusLabel = chalk.red(`ошибка  ${chalk.dim(shortErr)}`);
    } else if (status === 'disabled') {
      // Show which env vars are missing for bundled servers
      const def = BUNDLED_SERVERS.find(d => d.name === s.name);
      if (def?.requiresAuth) {
        const missing = getMissingRequiredEnv(def);
        if (missing.length > 0) {
          statusLabel = chalk.gray(`отключён  `) + chalk.dim(`нет: ${missing.join(', ')}`);
        } else {
          statusLabel = chalk.yellow('отключён  (включить: didev mcp)');
        }
      } else {
        statusLabel = chalk.gray('отключён');
      }
    } else {
      statusLabel = chalk.dim('не запущен в этой сессии');
    }

    console.log(`  ${icon}  ${chalk.bold(s.name.padEnd(14))}  ${statusLabel}`);
  }

  console.log('');

  // Show hints for disabled bundled servers that need env vars
  const needsSetup = BUNDLED_SERVERS.filter(def => {
    const missing = getMissingRequiredEnv(def);
    return def.requiresAuth && missing.length > 0;
  });
  if (needsSetup.length > 0) {
    console.log(chalk.dim('  Для активации требуются токены:'));
    for (const def of needsSetup) {
      const missing = getMissingRequiredEnv(def);
      for (const varName of missing) {
        const envDef = def.requiredEnv.find(e => e.name === varName);
        console.log(`  ${chalk.yellow('→')}  ${chalk.bold(varName.padEnd(24))} ${chalk.dim(envDef?.hint ?? '')}`);
      }
    }
    console.log(chalk.dim(`  Установить: ${chalk.cyan('didev config set VAR=value')}`));
    console.log('');
  }

  const { action } = await inquirer.prompt<{ action: string }>([{
    type: 'list',
    name: 'action',
    message: 'MCP серверы',
    choices: [
      { name: 'Добавить сервер', value: 'add' },
      ...(allServers.length > 0 ? [
        { name: 'Тестировать соединения', value: 'test' },
        { name: 'Удалить сервер', value: 'remove' },
      ] : []),
      sep(),
      { name: chalk.gray('Назад'), value: 'back' },
    ],
  }]);

  if (action === 'back') return;

  const { runMcpAdd, runMcpTest, runMcpRemove } = await import('./mcp.js');

  if (action === 'add') {
    await runMcpAdd();
  } else if (action === 'test') {
    await runMcpTest();
  } else if (action === 'remove' && allServers.length > 0) {
    const { serverName } = await inquirer.prompt<{ serverName: string }>([{
      type: 'list',
      name: 'serverName',
      message: 'Выберите сервер для удаления:',
      choices: allServers.map(s => ({ name: s.name, value: s.name })),
    }]);
    await runMcpRemove(serverName);
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

async function contextMenu(model: string): Promise<void> {
  const { action } = await inquirer.prompt<{ action: string }>([{
    type: 'list',
    name: 'action',
    message: 'Контекст проекта',
    choices: [
      { name: 'Показать базу знаний', value: 'show' },
      { name: 'Обновить базу знаний через AI', value: 'update' },
      sep(),
      { name: chalk.gray('Назад'), value: 'back' },
    ],
  }]);

  if (action === 'back') return;

  const { runContextShow, runContextUpdate } = await import('./context.js');

  if (action === 'show') {
    console.log('');
    await runContextShow();
    console.log('');
    await inquirer.prompt([{
      type: 'input',
      name: '_',
      message: chalk.gray('Enter для возврата...'),
    }]);
  } else if (action === 'update') {
    await runContextUpdate({ model });
  }
}

// ── Model selection ───────────────────────────────────────────────────────────

async function modelMenu(currentModel: string): Promise<void> {
  console.log('');

  const { choice } = await inquirer.prompt<{ choice: string }>([{
    type: 'list',
    name: 'choice',
    message: 'Выберите модель',
    choices: [
      ...MODELS.map(m => ({
        name:
          chalk.bold(m.name.padEnd(22)) +
          chalk.gray(m.desc) +
          (m.value === currentModel ? chalk.green('  ✓') : ''),
        value: m.value,
        short: m.value,
      })),
      sep(),
      { name: chalk.gray('Назад'), value: 'back' },
    ],
    pageSize: 6,
  }]);

  if (choice === 'back' || choice === currentModel) return;

  await setConfigValue('api.model', choice);
  console.log('');
  logger.success(`Модель установлена: ${chalk.bold(choice)}`);
  console.log('');
}

// ── Settings / Config ─────────────────────────────────────────────────────────

async function settingsMenu(): Promise<void> {
  const { action } = await inquirer.prompt<{ action: string }>([{
    type: 'list',
    name: 'action',
    message: 'Настройки',
    choices: [
      { name: 'Показать конфигурацию', value: 'show' },
      { name: 'Установить значение  (KEY=VALUE)', value: 'set' },
      sep(),
      { name: chalk.gray('Назад'), value: 'back' },
    ],
  }]);

  if (action === 'back') return;

  if (action === 'show') {
    const { runConfigShow } = await import('./config.js');
    console.log('');
    await runConfigShow();
    console.log('');
    await inquirer.prompt([{
      type: 'input',
      name: '_',
      message: chalk.gray('Enter для возврата...'),
    }]);
  } else if (action === 'set') {
    const { assignment } = await inquirer.prompt<{ assignment: string }>([{
      type: 'input',
      name: 'assignment',
      message: 'KEY=VALUE  (например: api.temperature=0.5):',
      validate: (v: string) => v.includes('=') || 'Формат: KEY=VALUE',
    }]);
    if (assignment?.trim()) {
      const { runConfigSet } = await import('./config.js');
      await runConfigSet(assignment.trim());
      console.log('');
    }
  }
}
