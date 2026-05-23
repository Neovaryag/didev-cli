import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { loadConfig, setConfigValue, getApiKey } from '../../core/config.js';

export async function runConfigSet(assignment: string): Promise<void> {
  const eqIdx = assignment.indexOf('=');
  if (eqIdx === -1) {
    logger.error('Usage: didev config set KEY=VALUE');
    process.exit(1);
  }

  const key = assignment.slice(0, eqIdx).trim();
  const value = assignment.slice(eqIdx + 1).trim();

  if (!key || !value) {
    logger.error('Both key and value are required');
    process.exit(1);
  }

  await setConfigValue(key, value);
  logger.success(`Set ${chalk.bold(key)} = ${key.toLowerCase().includes('key') ? '***' : chalk.cyan(value)}`);
}

export async function runConfigShow(): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);

  logger.banner('didev config', 'Current configuration');

  logger.bold('API');
  logger.table([
    ['provider', config.api.provider],
    ['model', config.api.model],
    ['apiKey', apiKey ? `${apiKey.slice(0, 6)}***${apiKey.slice(-4)}` : chalk.red('NOT SET')],
    ['maxTokens', String(config.api.maxTokens)],
    ['temperature', String(config.api.temperature)],
    ['baseUrl', config.api.baseUrl ?? 'https://api.deepseek.com/v1'],
  ]);

  logger.newline();
  logger.bold('Context');
  logger.table([
    ['maxFiles', String(config.context.maxFiles)],
    ['maxTokens', String(config.context.maxTokens)],
    ['autoDiscover', String(config.context.autoDiscover)],
  ]);

  logger.newline();
  logger.bold('Agents');
  logger.table([
    ['family', config.agents.family],
    ['orchestrate', String(config.agents.orchestrate)],
    ['reviewRequired', String(config.agents.reviewRequired)],
    ['autoApply', String(config.agents.autoApply)],
  ]);

  logger.newline();
  logger.bold('BMad');
  logger.table([
    ['enabled', String(config.bmad.enabled)],
    ['templatesPath', config.bmad.templatesPath],
  ]);

  logger.newline();
  logger.bold('Output');
  logger.table([
    ['style', config.output.style],
    ['color', String(config.output.color)],
    ['saveSessions', String(config.output.saveSessions)],
  ]);

  if (!apiKey) {
    logger.newline();
    logger.warn('API key not configured. Run: ' + chalk.cyan('didev config set DEEPSEEK_API_KEY=sk-xxx'));
  }
}
