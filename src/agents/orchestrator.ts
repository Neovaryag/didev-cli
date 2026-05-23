import chalk from 'chalk';
import boxen from 'boxen';
import { logger } from '../utils/logger.js';
import { collectProjectContext } from '../core/context.js';
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

function formatPipelineLabel(steps: PipelineStep[]): string {
  return steps
    .map(step =>
      Array.isArray(step)
        ? step.map(a => `${a.emoji} ${a.name}`).join(' + ')
        : `${step.emoji} ${step.name}`
    )
    .join(' → ');
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
  logger.newline();
  console.log(
    boxen(
      chalk.bold.cyan('🚀 didev agent') + '\n\n' +
      chalk.white(`Task: ${options.task}`) + '\n\n' +
      chalk.gray(`Pipeline: ${formatPipelineLabel(filteredPipeline)}`),
      { padding: 1, borderColor: 'cyan', borderStyle: 'double' }
    )
  );
  logger.newline();

  const agentResults: AgentResult[] = [];
  const allFileChanges: Map<string, 'created' | 'modified'> = new Map();

  const agentOptions: Omit<AgentOptions, 'previousResults'> = {
    client,
    model,
    projectContext: projectCtx,
    rootDir,
    task: options.task,
  };

  function trackFileChanges(fileChanges: AgentResult['fileChanges']): void {
    for (const fc of fileChanges) {
      allFileChanges.set(fc.path, allFileChanges.has(fc.path) ? 'modified' : 'created');
    }
  }

  for (const step of filteredPipeline) {
    const snapshot = agentResults.length > 0 ? [...agentResults] : undefined;

    if (Array.isArray(step)) {
      // Parallel stage — all agents get the same snapshot of previous results
      const settled = await Promise.allSettled(
        step.map(agent => agent.run({ ...agentOptions, previousResults: snapshot }))
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          agentResults.push(outcome.value);
          trackFileChanges(outcome.value.fileChanges);
          logger.dim(`  Completed in ${(outcome.value.duration / 1000).toFixed(1)}s`);
        } else {
          logger.error(`Agent failed: ${(outcome.reason as Error).message}`);
        }
      }
      logger.newline();
    } else {
      // Sequential step
      try {
        const result = await step.run({ ...agentOptions, previousResults: snapshot });
        agentResults.push(result);
        trackFileChanges(result.fileChanges);
        logger.dim(`  Completed in ${(result.duration / 1000).toFixed(1)}s`);
        logger.newline();
      } catch (e) {
        logger.error(`Agent ${step.name} failed: ${(e as Error).message}`);
      }
    }
  }

  const filesCreated = [...allFileChanges.entries()].filter(([, v]) => v === 'created').map(([k]) => k);
  const filesModified = [...allFileChanges.entries()].filter(([, v]) => v === 'modified').map(([k]) => k);

  const summary = buildSummary(options.task, agentResults, filesCreated, filesModified);

  // Display final summary
  displayFinalSummary(options.task, agentResults, filesCreated, filesModified, Date.now() - start);

  return {
    task: options.task,
    agentResults,
    totalDuration: Date.now() - start,
    filesCreated,
    filesModified,
    summary,
  };
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
  filesCreated: string[],
  filesModified: string[],
  durationMs: number
): void {
  logger.newline();

  const lines: string[] = [
    chalk.bold.green('✅ Task Complete'),
    '',
    chalk.gray(`Task: ${task}`),
    '',
  ];

  for (const r of results) {
    lines.push(`  ${chalk.green('✓')} ${r.emoji ?? ''} ${chalk.bold(r.agentName)} — ${chalk.gray((r.duration / 1000).toFixed(1) + 's')}`);
  }

  if (filesCreated.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Files created:'));
    filesCreated.forEach(f => lines.push(`  ${chalk.green('+')} ${f}`));
  }

  if (filesModified.length > 0) {
    lines.push('');
    lines.push(chalk.bold('Files modified:'));
    filesModified.forEach(f => lines.push(`  ${chalk.yellow('~')} ${f}`));
  }

  lines.push('');
  lines.push(chalk.gray(`Total time: ${(durationMs / 1000).toFixed(1)}s`));

  console.log(
    boxen(lines.join('\n'), {
      padding: 1,
      borderColor: 'green',
      borderStyle: 'round',
    })
  );
}
