import { logger } from '../../utils/logger.js';
import { runOrchestration } from '../../agents/orchestrator.js';
import type { AgentFamily, OrchestrationMode } from '../../agents/orchestrator.js';

export interface AgentCommandOptions {
  type?: AgentFamily;
  model?: string;
  mode?: OrchestrationMode;
  skip?: string;
  orchestrate?: boolean;
}

export async function runAgentCommand(
  task: string | undefined,
  options: AgentCommandOptions
): Promise<void> {
  if (!task && !options.orchestrate) {
    logger.error('Please provide a task. Example: didev agent "Add user authentication"');
    logger.dim('Or use --orchestrate for interactive task input');
    process.exit(1);
  }

  if (!task) {
    const inquirer = await import('inquirer');
    const { taskInput } = await inquirer.default.prompt([{
      type: 'input',
      name: 'taskInput',
      message: 'Describe the task for the agent family:',
      validate: (v: string) => v.trim().length > 5 || 'Please describe the task in more detail',
    }]);
    task = taskInput as string;
  }

  const skipAgents = options.skip?.split(',').map(s => s.trim()) ?? [];

  await runOrchestration({
    task: task!,
    family: options.type ?? 'auto',
    // Don't pass mode when unset — lets inferMode() in the orchestrator pick the leanest pipeline
    ...(options.mode ? { mode: options.mode } : {}),
    model: options.model,
    skipAgents: skipAgents.length > 0 ? skipAgents : undefined,
  });
}
