import { mkdir, writeFile, access } from 'fs/promises';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { logger } from '../../utils/logger.js';
import { collectProjectContext } from '../../core/context.js';
import { loadConfig, saveConfig } from '../../core/config.js';
import type { DidevConfig } from '../../core/config.js';
import { generateContextDocument } from './context.js';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export interface InitOptions {
  frontend?: boolean;
  backend?: boolean;
  fullstack?: boolean;
  yes?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  logger.banner('didev init', 'Initializing AI-powered development assistant');

  const rootDir = process.cwd();
  const didevDir = join(rootDir, '.didev');

  if (await exists(join(didevDir, 'config.yaml')) && !options.yes) {
    const { proceed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'proceed',
      message: chalk.yellow('.didev already exists. Reinitialize?'),
      default: false,
    }]);
    if (!proceed) {
      logger.info('Initialization cancelled.');
      return;
    }
  }

  const spinner = logger.spinner('Analyzing project...').start();

  let context;
  try {
    context = await collectProjectContext(rootDir);
    spinner.succeed(`Project detected: ${chalk.bold(context.name)}`);
  } catch (e) {
    spinner.fail('Failed to analyze project');
    context = null;
  }

  // Determine project type
  let projectType = context?.type ?? 'unknown';
  if (options.frontend) projectType = 'frontend';
  else if (options.backend) projectType = 'backend';
  else if (options.fullstack) projectType = 'fullstack';

  if (!options.yes && projectType === 'unknown') {
    const { type } = await inquirer.prompt([{
      type: 'list',
      name: 'type',
      message: 'Project type:',
      choices: ['frontend', 'backend', 'fullstack', 'mobile', 'library'],
    }]);
    projectType = type;
  }

  // Summary
  logger.newline();
  logger.table([
    ['Project', context?.name ?? 'unknown'],
    ['Type', projectType],
    ['Language', context?.language ?? 'unknown'],
    ['Framework', context?.framework ?? 'none'],
    ['Files', String(context?.stats.files ?? 0)],
    ['Lines', String(context?.stats.lines ?? 0)],
  ]);
  logger.newline();

  // Ask about BMad and API key
  let apiKey = process.env['DEEPSEEK_API_KEY'] ?? '';
  let enableBmad = true;

  if (!options.yes) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiKey',
        message: 'DeepSeek API key (leave empty to set later):',
        default: apiKey ? '***already set in env***' : '',
      },
      {
        type: 'confirm',
        name: 'enableBmad',
        message: 'Enable BMad Method?',
        default: true,
      },
    ]);

    if (answers['apiKey'] && !answers['apiKey'].startsWith('***')) {
      apiKey = answers['apiKey'];
    }
    enableBmad = answers['enableBmad'];
  }

  // Create directory structure
  spinner.text = 'Creating .didev structure...';
  spinner.start();
  const dirs = [
    didevDir,
    join(didevDir, 'sessions'),
    join(didevDir, 'reviews'),
    join(didevDir, 'bmad', 'epics'),
    join(didevDir, 'bmad', 'stories'),
    join(didevDir, 'bmad', 'architecture'),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  // Create config
  const config: DidevConfig = {
    api: {
      provider: 'deepseek',
      apiKey: apiKey || '${DEEPSEEK_API_KEY}',
      model: 'deepseek-v4-flash',
      maxTokens: 32768,
      temperature: 0.3,
      baseUrl: 'https://api.deepseek.com/v1',
    },
    context: {
      maxFiles: 100,
      maxTokens: 128000,
      autoDiscover: true,
      excludePatterns: ['node_modules/**', 'dist/**', '.git/**', '*.lock', '*.min.js', 'build/**'],
    },
    agents: {
      family: 'full',
      orchestrate: true,
      reviewRequired: true,
      autoApply: false,
    },
    bmad: {
      enabled: enableBmad,
      templatesPath: '.didev/bmad/templates',
      linkIssues: false,
    },
    output: {
      style: 'fancy',
      color: true,
      saveSessions: true,
    },
    mcp: {
      servers: [],
    },
  };

  await saveConfig(config, rootDir);

  // Create context.md — AI-generated if key is available, otherwise a template
  let contextMd: string;
  if (apiKey) {
    spinner.text = 'Генерирую базу знаний проекта через AI...';
    spinner.start();
    try {
      contextMd = await generateContextDocument(rootDir, apiKey, config.api.model);
      spinner.succeed('База знаний проекта создана (.didev/context.md)');
    } catch {
      spinner.warn('Не удалось сгенерировать базу знаний — создан шаблон');
      contextMd = context ? generateContextMd(context, projectType) : `# Project Context\n\nProject type: ${projectType}\n`;
    }
  } else {
    contextMd = context ? generateContextMd(context, projectType) : `# Project Context\n\nProject type: ${projectType}\n`;
  }
  await writeFile(join(didevDir, 'context.md'), contextMd, 'utf-8');

  // Create .gitignore entry
  await ensureGitignore(rootDir);

  spinner.succeed('.didev structure created');

  // Final summary
  logger.newline();
  logger.success('didev initialized successfully!');
  logger.newline();
  logger.dim('Quick start:');
  logger.dim(`  ${chalk.cyan('didev chat')}            — Start AI chat with project context`);
  logger.dim(`  ${chalk.cyan('didev agent "<task>"')}  — Run AI agent family`);
  logger.dim(`  ${chalk.cyan('didev review')}          — Review changed files`);
  if (!apiKey) {
    logger.newline();
    logger.warn('API key not set. Run: ' + chalk.cyan('didev config set DEEPSEEK_API_KEY=sk-xxx'));
    logger.dim('Then generate project knowledge base: ' + chalk.cyan('didev context update'));
  }
}

function generateContextMd(ctx: Awaited<ReturnType<typeof collectProjectContext>>, type: string): string {
  return `# Project Context

## Overview
- **Name**: ${ctx.name}
- **Type**: ${type}
- **Language**: ${ctx.language}
- **Framework**: ${ctx.framework}

## Purpose
<!-- Describe what this project does -->

## Key Concepts
<!-- List important domain concepts, patterns used -->

## Coding Standards
<!-- Style guide, conventions, rules to follow -->

## Architecture
<!-- Brief description of the architecture -->
`;
}

async function ensureGitignore(rootDir: string): Promise<void> {
  const gitignorePath = join(rootDir, '.gitignore');
  const entries = ['.didev/sessions', '.didev/secrets', '.env'];

  try {
    let content = '';
    if (await exists(gitignorePath)) {
      const { readFile } = await import('fs/promises');
      content = await readFile(gitignorePath, 'utf-8');
    }
    const toAdd = entries.filter(e => !content.includes(e));
    if (toAdd.length > 0) {
      const newContent = content + (content.endsWith('\n') ? '' : '\n') +
        '\n# didev\n' + toAdd.join('\n') + '\n';
      await writeFile(gitignorePath, newContent, 'utf-8');
    }
  } catch { /* not a critical failure */ }
}
