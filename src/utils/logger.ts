import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import type { Options as OraOptions, Ora } from 'ora';

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug' | 'agent';

export const icons = {
  info: 'ℹ',
  success: '✓',
  warn: '⚠',
  error: '✗',
  debug: '◆',
  ai: '🤖',
  agent: '🎯',
  think: '💭',
  file: '📄',
  folder: '📁',
  gear: '⚙',
  rocket: '🚀',
  check: '✅',
  cross: '❌',
  arrow: '→',
  dot: '•',
};

class Logger {
  private debugMode = process.env.DIDEV_DEBUG === '1';

  info(msg: string): void {
    console.log(chalk.cyan(`${icons.info} ${msg}`));
  }

  success(msg: string): void {
    console.log(chalk.green(`${icons.success} ${msg}`));
  }

  warn(msg: string): void {
    console.log(chalk.yellow(`${icons.warn} ${msg}`));
  }

  error(msg: string): void {
    console.error(chalk.red(`${icons.error} ${msg}`));
  }

  debug(msg: string): void {
    if (this.debugMode) {
      console.log(chalk.gray(`${icons.debug} [DEBUG] ${msg}`));
    }
  }

  agent(name: string, msg: string): void {
    console.log(chalk.magenta(`${icons.agent} ${chalk.bold(name)}:`) + ` ${msg}`);
  }

  agentHeader(name: string, role: string): void {
    console.log('');
    console.log(
      boxen(chalk.bold.magenta(`${icons.agent} ${name}`) + chalk.gray(`\n${role}`), {
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderColor: 'magenta',
        borderStyle: 'round',
      })
    );
  }

  step(emoji: string, msg: string): void {
    console.log(`  ${emoji} ${msg}`);
  }

  dim(msg: string): void {
    console.log(chalk.gray(msg));
  }

  bold(msg: string): void {
    console.log(chalk.bold(msg));
  }

  newline(): void {
    console.log('');
  }

  banner(title: string, subtitle?: string): void {
    const content = chalk.bold.cyan(title) + (subtitle ? `\n${chalk.gray(subtitle)}` : '');
    console.log(
      boxen(content, {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderColor: 'cyan',
        borderStyle: 'double',
        textAlignment: 'center',
      })
    );
  }

  result(title: string, body: string): void {
    console.log(
      boxen(chalk.bold(title) + '\n\n' + body, {
        padding: 1,
        borderColor: 'green',
        borderStyle: 'round',
      })
    );
  }

  table(rows: [string, string][]): void {
    const maxKey = Math.max(...rows.map(([k]) => k.length));
    for (const [key, val] of rows) {
      console.log(`  ${chalk.gray(key.padEnd(maxKey))}  ${chalk.white(val)}`);
    }
  }

  raw(msg: string): void {
    process.stdout.write(msg);
  }

  spinner(options: string | OraOptions): Ora {
    const opts: OraOptions = typeof options === 'string'
      ? { text: options }
      : options;
    return ora({ ...opts, stream: process.stdout });
  }
}

export const logger = new Logger();
