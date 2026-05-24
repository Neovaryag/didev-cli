import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import {
  detectAvailableScripts,
  runScript,
  summarizeErrors,
  type BuildResult,
  type BuildScript,
} from '../utils/build-runner.js';
import type { DeepSeekClient } from './api.js';
import type { ProjectContext } from './context.js';
import { readProjectFile, writeProjectFile } from './file-manager.js';

export interface PostApplyOptions {
  rootDir: string;
  client: DeepSeekClient;
  model: string;
  projectContext: ProjectContext;
  changedFiles: string[];
}

export async function runPostApplyChecks(options: PostApplyOptions): Promise<void> {
  const { rootDir, client, model, projectContext, changedFiles } = options;

  const scripts = await detectAvailableScripts(rootDir);
  if (scripts.length === 0) {
    logger.dim('  Скрипты сборки не обнаружены (нет package.json или известных скриптов)');
    return;
  }

  logger.newline();
  console.log(
    boxen(
      chalk.bold.cyan('🔧 Пост-применение') + '\n' +
      chalk.gray(`Доступно ${scripts.length} проверок: `) +
      scripts.map(s => chalk.white(s.label)).join(chalk.gray(', ')),
      { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderColor: 'cyan', borderStyle: 'round' }
    )
  );
  logger.newline();

  const { selected } = await inquirer.prompt<{ selected: string[] }>([{
    type: 'checkbox',
    name: 'selected',
    message: 'Что запустить после применения изменений?',
    choices: scripts.map(s => ({
      name: `${s.emoji}  ${s.label}`,
      value: s.name,
      checked: s.name === 'build' || s.name === 'typecheck' || s.name === 'tsc',
    })),
  }]);

  if (selected.length === 0) {
    logger.dim('  Ничего не выбрано — пропускаем');
    return;
  }

  const toRun = scripts.filter(s => selected.includes(s.name));

  logger.newline();
  logger.info(`Запускаем ${toRun.length} проверок...`);

  const results: BuildResult[] = [];
  for (const script of toRun) {
    const result = await runScript(script, rootDir);
    results.push(result);
  }

  const failed = results.filter(r => !r.success);

  logger.newline();
  printResultsTable(results);

  if (failed.length === 0) {
    logger.newline();
    console.log(chalk.green.bold('  ✅ Все проверки прошли успешно!'));
    return;
  }

  logger.newline();
  const { fixErrors } = await inquirer.prompt<{ fixErrors: boolean }>([{
    type: 'confirm',
    name: 'fixErrors',
    message: chalk.yellow(`Обнаружены ошибки в ${failed.length} проверках. Запустить AI-фикс?`),
    default: true,
  }]);

  if (!fixErrors) {
    logger.info('Фикс отклонён — продолжаем без исправлений');
    return;
  }

  await runAiFix({ client, model, projectContext, rootDir, changedFiles, failed });
}

// ── AI fix ────────────────────────────────────────────────────────────────────

async function runAiFix(opts: {
  client: DeepSeekClient;
  model: string;
  projectContext: ProjectContext;
  rootDir: string;
  changedFiles: string[];
  failed: BuildResult[];
}): Promise<void> {
  const { client, model, projectContext, rootDir, changedFiles, failed } = opts;

  const errorSummary = summarizeErrors(failed);

  // Gather content of changed files
  const fileContents: string[] = [];
  for (const f of changedFiles.slice(0, 10)) {
    try {
      const content = await readProjectFile(f, rootDir);
      fileContents.push(`=== ${f} ===\n${content}`);
    } catch { /* file may not exist */ }
  }

  const spinner = logger.spinner(`AI анализирует ${failed.length} ошибок...`);
  spinner.start();

  const systemPrompt = `You are an expert ${projectContext.language} developer.
Fix compilation/lint errors in the provided files.
Return ONLY the fixed file contents in this exact format for each file that needs changes:
<file path="RELATIVE/PATH">
FILE CONTENT HERE
</file>
Do not add explanations outside the file blocks.`;

  const userMessage = `The following build errors occurred after applying changes:

${errorSummary}

Changed files:
${fileContents.join('\n\n')}

Fix all errors. Return only the corrected file(s).`;

  try {
    const response = await client.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]);

    spinner.succeed('AI предложил исправления');

    const aiOutput = response.content ?? '';
    const fixedFiles = parseFileBlocks(aiOutput);

    if (fixedFiles.length === 0) {
      logger.warn('AI не предложил конкретных изменений файлов');
      console.log(chalk.gray(aiOutput.slice(0, 1000)));
      return;
    }

    logger.newline();
    console.log(chalk.bold(`  Предлагаемые исправления: ${fixedFiles.length} файл(а)`));
    for (const { path } of fixedFiles) {
      console.log(chalk.yellow(`    ~ ${path}`));
    }
    logger.newline();

    const { applyFix } = await inquirer.prompt<{ applyFix: boolean }>([{
      type: 'confirm',
      name: 'applyFix',
      message: 'Применить исправления?',
      default: true,
    }]);

    if (!applyFix) {
      logger.info('Исправления отклонены');
      return;
    }

    for (const { path, content } of fixedFiles) {
      await writeProjectFile(path, content, rootDir);
      logger.success(`Исправлен: ${path}`);
    }

    // Re-run the failed checks after fix
    const { rerun } = await inquirer.prompt<{ rerun: boolean }>([{
      type: 'confirm',
      name: 'rerun',
      message: 'Перезапустить проверки после исправлений?',
      default: true,
    }]);

    if (rerun) {
      logger.newline();
      logger.info('Перезапускаем упавшие проверки...');
      const reResults: BuildResult[] = [];
      for (const r of failed) {
        const result = await runScript(r.script, rootDir);
        reResults.push(result);
      }
      logger.newline();
      printResultsTable(reResults);
      const stillFailed = reResults.filter(r => !r.success);
      if (stillFailed.length === 0) {
        logger.success('Все проверки прошли после исправлений!');
      } else {
        logger.warn(`Остались ошибки в ${stillFailed.length} проверках. Запустите didev check для повторного анализа.`);
      }
    }
  } catch (err) {
    spinner.fail('Ошибка AI-фикса');
    logger.error((err as Error).message);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function parseFileBlocks(text: string): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];
  const re = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  for (const m of text.matchAll(re)) {
    result.push({ path: m[1].trim(), content: m[2].trim() + '\n' });
  }
  return result;
}

function printResultsTable(results: BuildResult[]): void {
  const lines: string[] = [''];
  for (const r of results) {
    const status = r.success
      ? chalk.green('✓ PASS')
      : chalk.red('✗ FAIL');
    const errCount = r.errors.filter(e => e.severity === 'error').length;
    const warnCount = r.errors.filter(e => e.severity === 'warning').length;
    const counts = r.success ? '' : chalk.gray(` · ${errCount} err${warnCount > 0 ? `, ${warnCount} warn` : ''}`);
    const time = chalk.gray(` ${(r.durationMs / 1000).toFixed(1)}s`);
    lines.push(`  ${r.script.emoji}  ${chalk.bold(r.script.label.padEnd(16))}  ${status}${counts}${time}`);
  }
  lines.push('');
  console.log(lines.join('\n'));
}

// ── standalone check command ──────────────────────────────────────────────────

export async function runCheckCommand(opts: { scripts?: string[]; fix?: boolean } = {}): Promise<void> {
  const rootDir = process.cwd();
  const allScripts = await detectAvailableScripts(rootDir);

  if (allScripts.length === 0) {
    logger.warn('Скрипты не обнаружены — нет package.json или известных скриптов build/lint/test');
    return;
  }

  let toRun: BuildScript[];

  if (opts.scripts && opts.scripts.length > 0) {
    toRun = allScripts.filter(s => opts.scripts!.includes(s.name) || opts.scripts!.includes(s.label.toLowerCase()));
    if (toRun.length === 0) {
      logger.warn(`Скрипты не найдены: ${opts.scripts.join(', ')}`);
      logger.info(`Доступные: ${allScripts.map(s => s.name).join(', ')}`);
      return;
    }
  } else if (opts.fix !== undefined) {
    // Non-interactive mode — run all
    toRun = allScripts;
  } else {
    // Interactive selection
    const { selected } = await inquirer.prompt<{ selected: string[] }>([{
      type: 'checkbox',
      name: 'selected',
      message: 'Выберите проверки для запуска:',
      choices: allScripts.map(s => ({
        name: `${s.emoji}  ${s.label}  ${chalk.gray(s.command + ' run ' + s.name)}`,
        value: s.name,
        checked: true,
      })),
    }]);
    toRun = allScripts.filter(s => selected.includes(s.name));
    if (toRun.length === 0) { logger.info('Ничего не выбрано'); return; }
  }

  const results: BuildResult[] = [];
  for (const script of toRun) {
    results.push(await runScript(script, rootDir));
  }

  logger.newline();
  printResultsTable(results);

  const failed = results.filter(r => !r.success);
  if (failed.length === 0) {
    logger.success('Все проверки прошли!');
    return;
  }

  if (opts.fix) {
    logger.warn(`${failed.length} проверок упали, но AI-фикс недоступен без контекста проекта`);
    logger.info('Используйте didev agent для AI-фикса с полным контекстом');
    return;
  }

  const { wantFix } = await inquirer.prompt<{ wantFix: boolean }>([{
    type: 'confirm',
    name: 'wantFix',
    message: `${failed.map(r => r.script.label).join(', ')} — запустить didev agent для исправления ошибок?`,
    default: false,
  }]);

  if (wantFix) {
    const { loadConfig, getApiKey } = await import('./config.js');
    const { initClient } = await import('./api.js');
    const { collectProjectContext } = await import('./context.js');

    const config = await loadConfig(rootDir);
    const apiKey = await getApiKey(config);
    if (!apiKey) { logger.error('DEEPSEEK_API_KEY не задан'); return; }

    const client = initClient({ apiKey, baseUrl: config.api.baseUrl, model: config.api.model, maxTokens: config.api.maxTokens, temperature: config.api.temperature });
    const projectContext = await collectProjectContext(rootDir);

    await runAiFix({ client, model: config.api.model, projectContext, rootDir, changedFiles: [], failed });
  }
}
