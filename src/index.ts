#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { printBanner } from './utils/banner.js';

const program = new Command();

program
  .name('didev')
  .description('AI-powered development CLI using DeepSeek API')
  .version('1.0.0')
  .addHelpText('after', `
${chalk.bold('Examples:')}
  ${chalk.cyan('didev init')}                              Initialize didev in current project
  ${chalk.cyan('didev config set DEEPSEEK_API_KEY=sk-x')} Set API key
  ${chalk.cyan('didev context update')}                    Generate project knowledge base (AI)
  ${chalk.cyan('didev chat')}                              Start AI chat with project context
  ${chalk.cyan('didev agent "Add user auth via JWT"')}     Run AI agent family
  ${chalk.cyan('didev review')}                            Review changed files
  ${chalk.cyan('didev refactor "Extract service layer"')}  Refactor code
  ${chalk.cyan('didev bmad epic')}                         Create BMad epic
`);

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize didev in the current project')
  .option('--frontend', 'Configure as frontend project')
  .option('--backend', 'Configure as backend project')
  .option('--fullstack', 'Configure as fullstack project')
  .option('-y, --yes', 'Skip interactive prompts')
  .action(async (opts) => {
    const { runInit } = await import('./cli/commands/init.js');
    await runInit(opts);
  });

// ── config ────────────────────────────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('Manage didev configuration');

configCmd
  .command('set <assignment>')
  .description('Set a config value (e.g. DEEPSEEK_API_KEY=sk-xxx or api.model=deepseek-reasoner)')
  .action(async (assignment: string) => {
    const { runConfigSet } = await import('./cli/commands/config.js');
    await runConfigSet(assignment);
  });

configCmd
  .command('show')
  .description('Show current configuration')
  .action(async () => {
    const { runConfigShow } = await import('./cli/commands/config.js');
    await runConfigShow();
  });

// Default config action — show if no subcommand
configCmd.action(async () => {
  const { runConfigShow } = await import('./cli/commands/config.js');
  await runConfigShow();
});

// ── chat ──────────────────────────────────────────────────────────────────────
program
  .command('chat')
  .description('Interactive AI chat with project context')
  .option('-m, --model <model>', 'Model: deepseek-v4-flash (default) | deepseek-v4-pro (thinking)')
  .option('-f, --file <path>', 'Add a specific file to the initial context')
  .action(async (opts) => {
    const { runChat } = await import('./cli/commands/chat.js');
    await runChat(opts);
  });

// ── agent ─────────────────────────────────────────────────────────────────────
program
  .command('agent [task]')
  .description('Run AI agent family to complete a development task')
  .option('-t, --type <family>', 'Agent family: frontend | backend | fullstack | auto', 'auto')
  .option('-m, --model <model>', 'Model to use')
  .option('--mode <mode>', 'Orchestration mode: full | light | developer-only', 'full')
  .option('--skip <agents>', 'Comma-separated list of agents to skip')
  .option('--orchestrate', 'Enter interactive task mode')
  .action(async (task: string | undefined, opts) => {
    const { runAgentCommand } = await import('./cli/commands/agent.js');
    await runAgentCommand(task, opts);
  });

// ── review ────────────────────────────────────────────────────────────────────
program
  .command('review')
  .description('AI-powered code review')
  .option('-a, --all', 'Review all source files')
  .option('-f, --file <path>', 'Review a specific file')
  .option('--pr', 'Review PR diff vs main branch')
  .option('-m, --model <model>', 'Model to use')
  .option('--no-save', 'Do not save review report')
  .action(async (opts) => {
    const { runReview } = await import('./cli/commands/review.js');
    await runReview(opts);
  });

// ── refactor ──────────────────────────────────────────────────────────────────
program
  .command('refactor [instruction]')
  .description('AI-powered refactoring')
  .option('--auto', 'Automatically detect and fix refactoring opportunities')
  .option('--dry-run', 'Preview changes without applying')
  .option('-f, --file <path>', 'Refactor a specific file')
  .option('-m, --model <model>', 'Model to use')
  .action(async (instruction: string | undefined, opts) => {
    const { runRefactor } = await import('./cli/commands/refactor.js');
    await runRefactor(instruction, opts);
  });

// ── context ───────────────────────────────────────────────────────────────────
const contextCmd = program
  .command('context')
  .description('Manage project knowledge base (.didev/context.md)');

contextCmd
  .command('update')
  .description('Generate or regenerate project knowledge base using AI')
  .option('-m, --model <model>', 'Model to use')
  .action(async (opts) => {
    const { runContextUpdate } = await import('./cli/commands/context.js');
    await runContextUpdate(opts);
  });

contextCmd
  .command('show')
  .description('Show current project knowledge base')
  .action(async () => {
    const { runContextShow } = await import('./cli/commands/context.js');
    await runContextShow();
  });

// Default context action — show if no subcommand
contextCmd.action(async () => {
  const { runContextShow } = await import('./cli/commands/context.js');
  await runContextShow();
});

// ── bmad ──────────────────────────────────────────────────────────────────────
const bmadCmd = program
  .command('bmad')
  .description('BMad Method — Behavior-Motivated Agile Development');

bmadCmd
  .command('init')
  .description('Initialize BMad in the current project')
  .action(async () => {
    const { runBmadInit } = await import('./bmad/method.js');
    await runBmadInit();
  });

bmadCmd
  .command('epic')
  .description('Create a new BMad epic')
  .action(async () => {
    const { runBmadEpic } = await import('./bmad/method.js');
    await runBmadEpic();
  });

bmadCmd
  .command('story')
  .description('Create a user story from an epic')
  .action(async () => {
    const { runBmadStory } = await import('./bmad/method.js');
    await runBmadStory();
  });

bmadCmd
  .command('implement')
  .description('Implement the current story using AI agents')
  .option('--story <id>', 'Story ID to implement')
  .action(async (opts) => {
    const { runBmadImplement } = await import('./bmad/method.js');
    await runBmadImplement(opts.story);
  });

bmadCmd
  .command('review')
  .description('Review the implementation of current story')
  .action(async () => {
    const { runBmadReview } = await import('./bmad/method.js');
    await runBmadReview();
  });

// ── mcp ───────────────────────────────────────────────────────────────────────
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP (Model Context Protocol) servers');

mcpCmd
  .command('list')
  .description('Show configured MCP servers')
  .action(async () => {
    const { runMcpList } = await import('./cli/commands/mcp.js');
    await runMcpList();
  });

mcpCmd
  .command('add [url]')
  .description('Add MCP server from URL (GitHub/GitLab/npm) or interactive wizard')
  .action(async (url?: string) => {
    const { runMcpAdd } = await import('./cli/commands/mcp.js');
    await runMcpAdd(url);
  });

mcpCmd
  .command('test [server]')
  .description('Test connection to MCP server(s)')
  .action(async (server?: string) => {
    const { runMcpTest } = await import('./cli/commands/mcp.js');
    await runMcpTest(server);
  });

mcpCmd
  .command('remove <server>')
  .description('Remove an MCP server from config')
  .action(async (server: string) => {
    const { runMcpRemove } = await import('./cli/commands/mcp.js');
    await runMcpRemove(server);
  });

// Default mcp action
mcpCmd.action(async () => {
  const { runMcpList } = await import('./cli/commands/mcp.js');
  await runMcpList();
});

// ── error handling ────────────────────────────────────────────────────────────
program.on('command:*', (operands: string[]) => {
  console.error(chalk.red(`Unknown command: ${operands[0]}`));
  console.log(`Run ${chalk.cyan('didev --help')} for available commands`);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error(chalk.red('Fatal error:'), err.message);
  if (process.env['DIDEV_DEBUG']) console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    console.error(chalk.red('Error:'), reason.message);
    if (process.env['DIDEV_DEBUG']) console.error(reason.stack);
  } else {
    console.error(chalk.red('Error:'), reason);
  }
  process.exit(1);
});

// ── graceful shutdown ─────────────────────────────────────────────────────────
let _shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  try {
    const { getMcpManager } = await import('./core/mcp.js');
    // Give MCP servers 5s to disconnect, then force exit
    await Promise.race([
      getMcpManager().disconnectAll(),
      new Promise<void>(r => setTimeout(r, 5_000)),
    ]);
  } catch { /* ignore cleanup errors */ }

  process.exit(signal === 'SIGINT' ? 130 : 0);
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

const _rawArgs = process.argv.slice(2);

// Show banner only for subcommands (not for bare invocation or --version)
const _isVersionFlag = _rawArgs.includes('--version') || _rawArgs.includes('-V');
const _isBareInvocation = _rawArgs.length === 0;

if (!_isVersionFlag && !_isBareInvocation) {
  printBanner('1.0.0');
}

// Bare `didev` (no args) → open interactive shell immediately
if (_isBareInvocation) {
  const { runChat } = await import('./cli/commands/chat.js');
  await runChat();
  process.exit(0);
}

program.parse();
