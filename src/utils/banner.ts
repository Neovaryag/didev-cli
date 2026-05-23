import chalk from 'chalk';

const ART = [
  ' ██████╗ ██╗██████╗ ███████╗██╗   ██╗',
  ' ██╔══██╗██║██╔══██╗██╔════╝██║   ██║',
  ' ██║  ██║██║██║  ██║█████╗  ╚██╗ ██╔╝',
  ' ██║  ██║██║██║  ██║██╔══╝   ╚████╔╝ ',
  ' ██████╔╝██║██████╔╝███████╗  ╚██╔╝  ',
  ' ╚═════╝ ╚═╝╚═════╝ ╚══════╝   ╚═╝   ',
];

// Purple → Electric Cyan gradient (top → bottom)
const GRAD = [
  chalk.hex('#CF00FF'),
  chalk.hex('#9922FF'),
  chalk.hex('#5555FF'),
  chalk.hex('#2288FF'),
  chalk.hex('#00BBFF'),
  chalk.hex('#00EEFF'),
];

const TAGLINES = [
  'Ship features at the speed of thought',
  'Your AI agent family is ready to code',
  'From idea to PR in one command',
  'Powered by DeepSeek · Built for devs',
  'Architect · Develop · Review · Repeat',
];

function center(str: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - str.length) / 2));
  return ' '.repeat(pad) + str;
}

export function printBanner(version = '1.0.0'): void {
  const width = ART[0].length;
  const tagline = TAGLINES[Math.floor(Date.now() / 1000) % TAGLINES.length];

  process.stdout.write('\n');

  for (let i = 0; i < ART.length; i++) {
    process.stdout.write(GRAD[i](ART[i]) + '\n');
  }

  process.stdout.write('\n');

  // Tagline
  process.stdout.write(
    chalk.bold.white(center(tagline, width)) + '\n'
  );

  process.stdout.write('\n');

  // Meta row: version · provider · license
  const meta = `v${version}  ✦  ⚡ DeepSeek  ✦  MIT`;
  process.stdout.write(
    chalk.hex('#666688')(center(meta, width)) + '\n'
  );

  process.stdout.write('\n');

  // Divider
  process.stdout.write(
    chalk.hex('#3344AA')('▀'.repeat(Math.floor(width / 2))) +
    chalk.hex('#00EEFF')('▀'.repeat(width - Math.floor(width / 2))) +
    '\n\n'
  );
}
