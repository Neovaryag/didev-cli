import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { collectProjectContext, loadContextDocument } from '../core/context.js';
import { loadConfig, getApiKey } from '../core/config.js';
import { initClient } from '../core/api.js';
import type { AgentResult, AgentOptions } from './base-agent.js';
import { BaseAgent } from './base-agent.js';
import { AnalystAgent, FrontendAnalystAgent, BackendAnalystAgent } from './analyst.js';
import { ArchitectAgent, FrontendArchitectAgent, BackendArchitectAgent } from './architect.js';
import { DeveloperAgent, FrontendDeveloperAgent, BackendDeveloperAgent } from './developer.js';
import { ReviewerAgent, SecurityAuditorAgent } from './reviewer.js';
import { TesterAgent, PerformanceAuditorAgent } from './tester.js';
import type { ProjectContext } from '../core/context.js';
import { initMcp } from '../core/mcp.js';
import { readProjectFile, writeProjectFile, renderDiff } from '../core/file-manager.js';
import { runPostApplyChecks } from '../core/post-apply.js';

export type AgentFamily = 'frontend' | 'backend' | 'fullstack' | 'auto';
export type OrchestrationMode = 'full' | 'light' | 'developer-only';

// A single agent or a group of agents that can run in parallel
type PipelineStep = BaseAgent | BaseAgent[];

export interface OrchestrationOptions {
  task: string;
  family?: AgentFamily;
  mode?: OrchestrationMode;
  model?: string;
  rootDir?: string;
  skipAgents?: string[];
  /** When true, agents queue writes and ask for confirmation before applying (default: true) */
  confirmWrites?: boolean;
}

export interface OrchestrationResult {
  task: string;
  agentResults: AgentResult[];
  totalDuration: number;
  filesCreated: string[];
  filesModified: string[];
  summary: string;
}

function buildPipeline(
  family: AgentFamily,
  projectCtx: ProjectContext,
  mode: OrchestrationMode
): PipelineStep[] {
  const resolvedFamily =
    family === 'auto'
      ? (projectCtx.type === 'frontend' ? 'frontend'
        : projectCtx.type === 'backend' ? 'backend'
        : 'fullstack')
      : family;

  if (mode === 'developer-only') {
    if (resolvedFamily === 'frontend') return [new FrontendDeveloperAgent()];
    if (resolvedFamily === 'backend') return [new BackendDeveloperAgent()];
    return [new DeveloperAgent()];
  }

  if (mode === 'light') {
    if (resolvedFamily === 'frontend') {
      return [new FrontendAnalystAgent(), new FrontendDeveloperAgent(), new ReviewerAgent()];
    }
    if (resolvedFamily === 'backend') {
      return [new BackendAnalystAgent(), new BackendDeveloperAgent(), new ReviewerAgent()];
    }
    return [new AnalystAgent(), new DeveloperAgent(), new ReviewerAgent()];
  }

  // Full pipeline — review-phase agents run in parallel (they only read, not depend on each other)
  if (resolvedFamily === 'frontend') {
    return [
      new FrontendAnalystAgent(),
      new FrontendArchitectAgent(),
      new FrontendDeveloperAgent(),
      [new ReviewerAgent(), new TesterAgent()],
    ];
  }

  if (resolvedFamily === 'backend') {
    return [
      new BackendAnalystAgent(),
      new BackendArchitectAgent(),
      new BackendDeveloperAgent(),
      [new SecurityAuditorAgent(), new ReviewerAgent(), new TesterAgent()],
    ];
  }

  // Fullstack
  return [
    new AnalystAgent(),
    new ArchitectAgent(),
    new DeveloperAgent(),
    [new ReviewerAgent(), new TesterAgent()],
  ];
}

function pipelineAgents(steps: PipelineStep[]): BaseAgent[] {
  return steps.flatMap(s => Array.isArray(s) ? s : [s]);
}

function filterPipeline(steps: PipelineStep[], skip: string[]): PipelineStep[] {
  return steps
    .map(step => {
      if (Array.isArray(step)) {
        const filtered = step.filter(a => !skip.includes(a.name));
        return filtered.length > 0 ? filtered : null;
      }
      return skip.includes(step.name) ? null : step;
    })
    .filter((s): s is PipelineStep => s !== null);
}

function formatPipelineBox(steps: PipelineStep[], family: string, mode: string): string {
  const lines: string[] = [];
  const header = chalk.bold.cyan('🚀 didev agent family');
  const meta = chalk.gray(`${family} · ${mode} · ${steps.length} шагов`);
  lines.push(header);
  lines.push(meta);
  lines.push('');
  steps.forEach((step, i) => {
    const num = chalk.bold.white(`${i + 1}.`);
    if (Array.isArray(step)) {
      lines.push(`  ${num}  ${chalk.yellow('⚡ параллельно')}  [${step.length} агента]`);
      step.forEach(a => lines.push(`       ${a.emoji} ${chalk.dim(a.name)}  ${chalk.dim('—')} ${chalk.dim(a.description)}`));
    } else {
      lines.push(`  ${num}  ${step.emoji} ${chalk.bold(step.name)}  ${chalk.dim('—')} ${chalk.dim(step.description)}`);
    }
  });
  return lines.join('\n');
}

export async function runOrchestration(options: OrchestrationOptions): Promise<OrchestrationResult> {
  const start = Date.now();
  const rootDir = options.rootDir ?? process.cwd();

  const config = await loadConfig(rootDir);
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

  const model = options.model ?? config.api.model;
  const projectCtx = await collectProjectContext(rootDir);
  const contextDocument = await loadContextDocument(rootDir) ?? undefined;

  // Connect MCP servers before agents start — shared via singleton McpManager
  const mcp = await initMcp(config.mcp?.servers ?? []);
  if (mcp.tools.length > 0) {
    logger.success(`MCP: ${mcp.tools.length} tool(s) available to agents`);
  }

  const mode = options.mode ?? (config.agents.family as OrchestrationMode) ?? 'full';
  const family = options.family ?? 'auto';

  const pipeline = buildPipeline(family, projectCtx, mode as OrchestrationMode);
  const filteredPipeline = options.skipAgents
    ? filterPipeline(pipeline, options.skipAgents)
    : pipeline;

  // Display orchestration plan
  const resolvedFamily = family === 'auto'
    ? (projectCtx.type === 'frontend' ? 'frontend' : projectCtx.type === 'backend' ? 'backend' : 'fullstack')
    : family;
  logger.newline();
  console.log(
    boxen(
      chalk.white(`Задача: ${options.task}`) + '\n\n' +
      formatPipelineBox(filteredPipeline, resolvedFamily, mode),
      { padding: 1, borderColor: 'cyan', borderStyle: 'double' }
    )
  );
  logger.newline();

  const agentResults: AgentResult[] = [];
  const failedAgents: { name: string; error: string }[] = [];
  const allFileChanges: Map<string, 'created' | 'modified'> = new Map();

  // confirmWrites defaults to true — always ask before touching the filesystem
  const confirmWrites = options.confirmWrites !== false;

  const agentOptions: Omit<AgentOptions, 'previousResults'> = {
    client,
    model,
    projectContext: projectCtx,
    rootDir,
    task: options.task,
    dryRun: confirmWrites,
    contextDocument,
  };

  function trackFileChanges(fileChanges: AgentResult['fileChanges']): void {
    for (const fc of fileChanges) {
      allFileChanges.set(fc.path, allFileChanges.has(fc.path) ? 'modified' : 'created');
    }
  }

  // Collect all pending writes across all agents (dry-run mode)
  const allPendingWrites = new Map<string, { content: string; description?: string }>();

  // Sequential critical agents — if one fails, pipeline cannot meaningfully continue
  const CRITICAL_AGENTS = new Set(['Analyst', 'Frontend Analyst', 'Backend Analyst',
    'Architect', 'Frontend Architect', 'Backend Architect',
    'Developer', 'Frontend Developer', 'Backend Developer']);

  const totalSteps = filteredPipeline.length;

  for (let stepIdx = 0; stepIdx < filteredPipeline.length; stepIdx++) {
    const step = filteredPipeline[stepIdx];
    const stepNum = stepIdx + 1;
    const snapshot = agentResults.length > 0 ? [...agentResults] : undefined;

    if (Array.isArray(step)) {
      // Parallel stage header
      const names = step.map(a => `${a.emoji} ${a.name}`).join('  ');
      console.log(chalk.cyan('─'.repeat(54)));
      console.log(
        `  ${chalk.gray('▶')}  ${chalk.bold.white(`Шаг ${stepNum}/${totalSteps}`)}  ${chalk.yellow('⚡ параллельный запуск')}  [${step.length} агента]`
      );
      console.log(`     ${chalk.dim(names)}`);
      console.log('');

      const settled = await Promise.allSettled(
        step.map(agent => agent.run({
          ...agentOptions,
          previousResults: snapshot,
          stepInfo: { current: stepNum, total: totalSteps, parallel: true },
        }))
      );
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const agentName = (step[i] as BaseAgent).name;
        if (outcome.status === 'fulfilled') {
          agentResults.push(outcome.value);
          trackFileChanges(outcome.value.fileChanges);
          for (const [path, entry] of outcome.value.pendingWrites) {
            allPendingWrites.set(path, entry);
          }
        } else {
          const errMsg = (outcome.reason as Error).message;
          failedAgents.push({ name: agentName, error: errMsg });
          logger.error(`Агент ${agentName} завершился с ошибкой: ${errMsg}`);
        }
      }
      logger.newline();
    } else {
      // Sequential step
      try {
        const result = await step.run({
          ...agentOptions,
          previousResults: snapshot,
          stepInfo: { current: stepNum, total: totalSteps },
        });
        agentResults.push(result);
        trackFileChanges(result.fileChanges);
        for (const [path, entry] of result.pendingWrites) {
          allPendingWrites.set(path, entry);
        }
        logger.newline();
      } catch (e) {
        const errMsg = (e as Error).message;
        failedAgents.push({ name: step.name, error: errMsg });
        logger.error(`Агент ${step.name} завершился с ошибкой: ${errMsg}`);

        // Critical agent failed — no point running downstream agents without its output
        if (CRITICAL_AGENTS.has(step.name)) {
          logger.warn(`Пайплайн остановлен: ${step.name} не выполнил задачу, следующие агенты зависят от его результата.`);
          break;
        }
      }
    }
  }

  // ── Preview & confirm file writes ────────────────────────────────────────
  if (confirmWrites && allPendingWrites.size > 0) {
    await confirmAndApplyWrites(allPendingWrites, rootDir, allFileChanges);
  }

  // ── Post-apply: build / lint / typecheck ──────────────────────────────────
  const changedPaths = [...allFileChanges.keys()];
  if (changedPaths.length > 0) {
    await runPostApplyChecks({ rootDir, client, model, projectContext: projectCtx, changedFiles: changedPaths });
  }

  const filesCreated = [...allFileChanges.entries()].filter(([, v]) => v === 'created').map(([k]) => k);
  const filesModified = [...allFileChanges.entries()].filter(([, v]) => v === 'modified').map(([k]) => k);

  const summary = buildSummary(options.task, agentResults, filesCreated, filesModified);

  // Display final summary
  displayFinalSummary(options.task, agentResults, failedAgents, filesCreated, filesModified, Date.now() - start);

  return {
    task: options.task,
    agentResults,
    totalDuration: Date.now() - start,
    filesCreated,
    filesModified,
    summary,
  };
}

async function confirmAndApplyWrites(
  pendingWrites: Map<string, { content: string; description?: string }>,
  rootDir: string,
  allFileChanges: Map<string, 'created' | 'modified'>
): Promise<void> {
  logger.newline();

  const lines: string[] = [
    chalk.bold.yellow('📝 Агенты подготовили изменения'),
    '',
    chalk.gray(`Файлов к записи: ${pendingWrites.size}`),
    '',
  ];

  for (const [path, { description }] of pendingWrites) {
    const exists = await readProjectFile(path, rootDir).then(() => true).catch(() => false);
    const tag = exists ? chalk.yellow('~') : chalk.green('+');
    const label = exists ? 'изменение' : 'новый файл';
    lines.push(`  ${tag} ${chalk.white(path)}  ${chalk.gray(description ?? label)}`);
  }

  console.log(boxen(lines.join('\n'), { padding: 1, borderColor: 'yellow', borderStyle: 'round' }));
  logger.newline();

  // Show full diffs per file
  const { showDiffs } = await inquirer.prompt([{
    type: 'confirm',
    name: 'showDiffs',
    message: 'Показать diff изменений перед применением?',
    default: true,
  }]);

  if (showDiffs) {
    for (const [path, { content }] of pendingWrites) {
      const original = await readProjectFile(path, rootDir).catch(() => '');
      logger.newline();
      logger.bold(`── ${path} ──`);
      console.log(renderDiff(path, original, content));
    }
    logger.newline();
  }

  const { apply } = await inquirer.prompt([{
    type: 'confirm',
    name: 'apply',
    message: `Применить ${pendingWrites.size} файл(ов)?`,
    default: true,
  }]);

  if (apply) {
    for (const [path, { content }] of pendingWrites) {
      const existed = await readProjectFile(path, rootDir).then(() => true).catch(() => false);
      await writeProjectFile(path, content, rootDir);
      allFileChanges.set(path, existed ? 'modified' : 'created');
      logger.success(`Записан: ${path}`);
    }
  } else {
    logger.info('Изменения отклонены — файлы не тронуты');
  }
}

function buildSummary(
  task: string,
  results: AgentResult[],
  filesCreated: string[],
  filesModified: string[]
): string {
  const lines = [`# Task: ${task}`, ''];
  for (const r of results) {
    lines.push(`## ${r.emoji ?? ''} ${r.agentName}`);
    lines.push(r.output.slice(0, 10_000));
    lines.push('');
  }
  if (filesCreated.length > 0) {
    lines.push(`## Files Created\n${filesCreated.map(f => `- ${f}`).join('\n')}`);
  }
  if (filesModified.length > 0) {
    lines.push(`\n## Files Modified\n${filesModified.map(f => `- ${f}`).join('\n')}`);
  }
  return lines.join('\n');
}

function displayFinalSummary(
  task: string,
  results: AgentResult[],
  failed: { name: string; error: string }[],
  filesCreated: string[],
  filesModified: string[],
  durationMs: number
): void {
  logger.newline();

  const hasFailures = failed.length > 0;
  const hasSuccesses = results.length > 0;

  // Determine overall status
  let statusLine: string;
  let borderColor: 'green' | 'yellow' | 'red';

  if (!hasFailures) {
    statusLine = chalk.bold.green('✅ Задача выполнена');
    borderColor = 'green';
  } else if (hasSuccesses) {
    statusLine = chalk.bold.yellow(`⚠️  Задача выполнена частично  (${failed.length} агент(а) не справились)`);
    borderColor = 'yellow';
  } else {
    statusLine = chalk.bold.red('❌ Задача не выполнена — все агенты завершились с ошибкой');
    borderColor = 'red';
  }

  const lines: string[] = [
    statusLine,
    '',
    chalk.gray(`Задача: ${task}`),
    '',
  ];

  // Successful agents
  for (const r of results) {
    lines.push(`  ${chalk.green('✓')}  ${r.emoji ?? ''} ${chalk.bold(r.agentName)}  ${chalk.dim((r.duration / 1000).toFixed(1) + 's')}`);
  }

  // Failed agents
  if (failed.length > 0) {
    if (hasSuccesses) lines.push('');
    for (const f of failed) {
      const isTimeout = /timed out|timeout/i.test(f.error);
      const reason = isTimeout ? chalk.dim('таймаут DeepSeek') : chalk.dim(f.error.slice(0, 60));
      lines.push(`  ${chalk.red('✖')}  ${chalk.bold(f.name)}  ${reason}`);
    }
    lines.push('');
    if (failed.some(f => /timed out|timeout/i.test(f.error))) {
      lines.push(chalk.dim('  Совет: запустите задачу снова или разбейте её на меньшие шаги.'));
      lines.push(chalk.dim('  Используйте: didev agent --mode light "<задача>"'));
    }
  }

  if (filesCreated.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Создано файлов:'));
    filesCreated.forEach(f => lines.push(`  ${chalk.green('+')} ${f}`));
  }

  if (filesModified.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Изменено файлов:'));
    filesModified.forEach(f => lines.push(`  ${chalk.yellow('~')} ${f}`));
  }

  lines.push('');
  lines.push(chalk.gray(`Время: ${(durationMs / 1000).toFixed(1)}s`));

  console.log(
    boxen(lines.join('\n'), {
      padding: 1,
      borderColor,
      borderStyle: 'round',
    })
  );
}
