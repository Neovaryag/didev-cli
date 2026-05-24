import { spawn } from 'child_process';
import { readFile, access, readdir } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { logger } from './logger.js';

export interface BuildScript {
  name: string;
  label: string;
  command: string;
  args: string[];
  emoji: string;
  /** Working directory override — defaults to rootDir if omitted */
  cwd?: string;
}

export interface BuildResult {
  script: BuildScript;
  exitCode: number;
  success: boolean;
  output: string;
  errors: ParsedError[];
  durationMs: number;
}

export interface ParsedError {
  file?: string;
  line?: number;
  col?: number;
  severity: 'error' | 'warning';
  message: string;
  raw: string;
}

// ── script detection ──────────────────────────────────────────────────────────

const KNOWN_SCRIPTS: Record<string, Omit<BuildScript, 'command' | 'args' | 'cwd'>> = {
  // Universal
  build:          { name: 'build',          label: 'Build',           emoji: '🔨' },
  typecheck:      { name: 'typecheck',      label: 'Type check',      emoji: '🔍' },
  'type-check':   { name: 'type-check',     label: 'Type check',      emoji: '🔍' },
  tsc:            { name: 'tsc',            label: 'TypeScript',       emoji: '🔍' },
  lint:           { name: 'lint',           label: 'Lint',             emoji: '🧹' },
  'lint:fix':     { name: 'lint:fix',       label: 'Lint (fix)',       emoji: '🧹' },
  test:           { name: 'test',           label: 'Tests',            emoji: '🧪' },
  'test:ci':      { name: 'test:ci',        label: 'Tests (CI)',       emoji: '🧪' },
  'test:unit':    { name: 'test:unit',      label: 'Unit tests',       emoji: '🧪' },
  validate:       { name: 'validate',       label: 'Validate',         emoji: '✅' },
  check:          { name: 'check',          label: 'Check',            emoji: '✅' },
  // Frontend / UI
  preview:        { name: 'preview',        label: 'Preview',          emoji: '👁️' },
  serve:          { name: 'serve',          label: 'Serve',            emoji: '🌐' },
  'build:prod':   { name: 'build:prod',     label: 'Build (prod)',     emoji: '🔨' },
  'build:ssr':    { name: 'build:ssr',      label: 'Build (SSR)',      emoji: '🔨' },
  storybook:      { name: 'storybook',      label: 'Storybook',        emoji: '📖' },
  'build-storybook': { name: 'build-storybook', label: 'Build Storybook', emoji: '📖' },
  // E2E / integration
  e2e:            { name: 'e2e',            label: 'E2E tests',        emoji: '🌐' },
  'test:e2e':     { name: 'test:e2e',       label: 'E2E tests',        emoji: '🌐' },
  cypress:        { name: 'cypress',        label: 'Cypress',          emoji: '🌲' },
  'cy:run':       { name: 'cy:run',         label: 'Cypress (run)',    emoji: '🌲' },
  playwright:     { name: 'playwright',     label: 'Playwright',       emoji: '🎭' },
  'test:playwright': { name: 'test:playwright', label: 'Playwright',   emoji: '🎭' },
};

async function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

function npmOrPnpm(rootDir: string): Promise<'pnpm' | 'npm' | 'yarn'> {
  return readFile(join(rootDir, 'pnpm-lock.yaml')).then(() => 'pnpm' as const)
    .catch(() => readFile(join(rootDir, 'yarn.lock')).then(() => 'yarn' as const)
    .catch(() => 'npm' as const));
}

async function detectNodeScripts(rootDir: string): Promise<BuildScript[]> {
  try {
    const raw = await readFile(join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const pm = await npmOrPnpm(rootDir);

    const found: BuildScript[] = [];
    for (const [scriptName] of Object.entries(scripts)) {
      const meta = KNOWN_SCRIPTS[scriptName];
      if (meta) {
        found.push({ ...meta, name: scriptName, command: pm, args: ['run', scriptName] });
      }
    }

    const seen = new Set<string>();
    return found.filter(s => {
      if (seen.has(s.label)) return false;
      seen.add(s.label);
      return true;
    });
  } catch {
    return [];
  }
}

async function detectMavenScripts(rootDir: string): Promise<BuildScript[]> {
  const hasPom = await fileExists(join(rootDir, 'pom.xml'));
  if (!hasPom) {
    // Try one level up (multi-module: rootDir might be a submodule)
    const parentPom = await fileExists(join(rootDir, '..', 'pom.xml'));
    if (!parentPom) return [];
  }
  const isWin = process.platform === 'win32';
  const mvnw = join(rootDir, isWin ? 'mvnw.cmd' : 'mvnw');
  const hasMvnw = await fileExists(mvnw);
  const mvn = hasMvnw ? (isWin ? 'mvnw.cmd' : './mvnw') : 'mvn';
  return [
    { name: 'compile',         label: 'Compile',        emoji: '🔨', command: mvn, args: ['compile', '-q'] },
    { name: 'test',            label: 'Tests',           emoji: '🧪', command: mvn, args: ['test'] },
    { name: 'verify',          label: 'Verify',          emoji: '✅', command: mvn, args: ['verify'] },
    { name: 'package',         label: 'Package (jar)',   emoji: '📦', command: mvn, args: ['package', '-DskipTests', '-q'] },
    { name: 'checkstyle',      label: 'Checkstyle',      emoji: '🧹', command: mvn, args: ['checkstyle:check'] },
    { name: 'spotbugs',        label: 'SpotBugs',        emoji: '🐛', command: mvn, args: ['spotbugs:check'] },
  ];
}

async function detectGradleScripts(rootDir: string): Promise<BuildScript[]> {
  const hasBuild = await fileExists(join(rootDir, 'build.gradle'))
    || await fileExists(join(rootDir, 'build.gradle.kts'));
  if (!hasBuild) return [];
  const isWin = process.platform === 'win32';
  const gradlew = join(rootDir, isWin ? 'gradlew.bat' : 'gradlew');
  const hasGradlew = await fileExists(gradlew);
  const gradle = hasGradlew ? (isWin ? 'gradlew.bat' : './gradlew') : 'gradle';
  return [
    { name: 'build',         label: 'Build',          emoji: '🔨', command: gradle, args: ['build'] },
    { name: 'test',          label: 'Tests',           emoji: '🧪', command: gradle, args: ['test'] },
    { name: 'check',         label: 'Check',           emoji: '✅', command: gradle, args: ['check'] },
    { name: 'assemble',      label: 'Assemble (jar)',  emoji: '📦', command: gradle, args: ['assemble'] },
    { name: 'spotlessCheck', label: 'Spotless',        emoji: '🧹', command: gradle, args: ['spotlessCheck'] },
  ];
}

// Angular projects use `ng` directly (angular.json defines project scripts)
async function detectAngularScripts(dir: string, labelSuffix = ''): Promise<BuildScript[]> {
  const hasAngular = await fileExists(join(dir, 'angular.json'));
  if (!hasAngular) return [];
  const suffix = labelSuffix ? ` (${labelSuffix})` : '';
  return [
    { name: 'build',       label: `Build${suffix}`,          emoji: '🔨', command: 'ng', args: ['build'],       cwd: dir },
    { name: 'test',        label: `Tests${suffix}`,           emoji: '🧪', command: 'ng', args: ['test', '--watch=false'], cwd: dir },
    { name: 'lint',        label: `Lint${suffix}`,            emoji: '🧹', command: 'ng', args: ['lint'],        cwd: dir },
    { name: 'e2e',         label: `E2E tests${suffix}`,       emoji: '🌐', command: 'ng', args: ['e2e'],         cwd: dir },
    { name: 'build:prod',  label: `Build (prod)${suffix}`,   emoji: '🔨', command: 'ng', args: ['build', '--configuration=production'], cwd: dir },
  ];
}

// Scan common UI subdirectory names for their own package.json / angular.json
const UI_SUBDIRS = ['frontend', 'ui', 'client', 'web', 'app', 'webapp', 'portal', 'admin'];

async function detectSubdirFrontend(rootDir: string): Promise<BuildScript[]> {
  const results: BuildScript[] = [];

  let entries: string[] = [];
  try {
    const dirents = await readdir(rootDir, { withFileTypes: true });
    entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!UI_SUBDIRS.includes(name.toLowerCase())) continue;
    const subdir = join(rootDir, name);

    const [nodeScripts, angularScripts] = await Promise.all([
      detectNodeScripts(subdir),
      detectAngularScripts(subdir, name),
    ]);

    // Tag node scripts with subdir label and set their cwd
    for (const s of nodeScripts) {
      results.push({ ...s, label: `${s.label} (${name})`, cwd: subdir });
    }
    results.push(...angularScripts);
  }

  return results;
}

export async function detectAvailableScripts(rootDir: string): Promise<BuildScript[]> {
  const [node, angular, maven, gradle, subdirFrontend] = await Promise.all([
    detectNodeScripts(rootDir),
    detectAngularScripts(rootDir),
    detectMavenScripts(rootDir),
    detectGradleScripts(rootDir),
    detectSubdirFrontend(rootDir),
  ]);
  return [...node, ...angular, ...maven, ...gradle, ...subdirFrontend];
}

// ── runner ────────────────────────────────────────────────────────────────────

export async function runScript(
  script: BuildScript,
  rootDir: string,
  { stream = true }: { stream?: boolean } = {}
): Promise<BuildResult> {
  const start = Date.now();
  const outputChunks: string[] = [];

  logger.newline();
  const cmdDisplay = [script.command, ...script.args].join(' ');
  console.log(chalk.bold(`  ${script.emoji} ${script.label}`) + chalk.gray(`  →  ${cmdDisplay}`));
  console.log(chalk.gray('  ' + '─'.repeat(52)));

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      isWindows ? `${script.command}.cmd` : script.command,
      script.args,
      {
        cwd: script.cwd ?? rootDir,
        shell: isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
      }
    );

    const handleChunk = (chunk: Buffer): void => {
      const text = chunk.toString();
      outputChunks.push(text);
      if (stream) {
        process.stdout.write(text.split('\n').map(l => '  ' + l).join('\n'));
      }
    };

    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', handleChunk);

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      const output = outputChunks.join('');
      const success = exitCode === 0;
      const errors = parseErrors(output);
      const durationMs = Date.now() - start;

      logger.newline();
      if (success) {
        console.log(chalk.green(`  ✓ ${script.label} passed`) + chalk.gray(` (${(durationMs / 1000).toFixed(1)}s)`));
      } else {
        console.log(chalk.red(`  ✗ ${script.label} failed`) + chalk.gray(` (${(durationMs / 1000).toFixed(1)}s, ${errors.filter(e => e.severity === 'error').length} errors)`));
      }

      resolve({ script, exitCode, success, output, errors, durationMs });
    });

    child.on('error', (err) => {
      const output = `spawn error: ${err.message}`;
      outputChunks.push(output);
      if (stream) console.log(chalk.red('  ' + output));
      resolve({
        script,
        exitCode: 1,
        success: false,
        output,
        errors: [{ severity: 'error', message: err.message, raw: output }],
        durationMs: Date.now() - start,
      });
    });
  });
}

// ── error parsers ─────────────────────────────────────────────────────────────

function parseErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const seen = new Set<string>();

  const add = (e: ParsedError): void => {
    const key = `${e.file ?? ''}:${e.line ?? ''}:${e.message}`;
    if (!seen.has(key)) { seen.add(key); errors.push(e); }
  };

  // TypeScript: src/foo.ts(10,5): error TS2345: ...
  const tsRe = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
  for (const m of output.matchAll(tsRe)) {
    add({ file: m[1], line: +m[2], col: +m[3], severity: m[4] as 'error' | 'warning', message: m[5], raw: m[0] });
  }

  // ESLint: /path/to/file.ts\n  10:5  error  message  rule-name
  const eslintFileRe = /^(.+\.[jt]sx?)$/gm;
  const eslintLineRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}\S/gm;
  let currentFile = '';
  for (const line of output.split('\n')) {
    const fm = eslintFileRe.exec(line);
    if (fm) { currentFile = fm[1]; eslintFileRe.lastIndex = 0; continue; }
    const lm = eslintLineRe.exec(line);
    if (lm && currentFile) {
      add({ file: currentFile, line: +lm[1], col: +lm[2], severity: lm[3] as 'error' | 'warning', message: lm[4].trim(), raw: line });
      eslintLineRe.lastIndex = 0;
    }
  }

  // Maven: [ERROR] /path/File.java:[10,5] some error message
  const mavenRe = /^\[ERROR\]\s+(.+\.java):\[(\d+),(\d+)\]\s+(.+)$/gm;
  for (const m of output.matchAll(mavenRe)) {
    add({ file: m[1], line: +m[2], col: +m[3], severity: 'error', message: m[4], raw: m[0] });
  }

  // Maven: [WARNING] /path/File.java:[10,5] ...
  const mavenWarnRe = /^\[WARNING\]\s+(.+\.java):\[(\d+),(\d+)\]\s+(.+)$/gm;
  for (const m of output.matchAll(mavenWarnRe)) {
    add({ file: m[1], line: +m[2], col: +m[3], severity: 'warning', message: m[4], raw: m[0] });
  }

  // Javac: File.java:10: error: message
  const javacRe = /^(.+\.java):(\d+):\s+(error|warning):\s+(.+)$/gm;
  for (const m of output.matchAll(javacRe)) {
    add({ file: m[1], line: +m[2], severity: m[3] as 'error' | 'warning', message: m[4], raw: m[0] });
  }

  // Gradle: e: /path/File.kt:10:5: error message
  const gradleKtRe = /^e:\s+(.+\.kt):(\d+):(\d+):\s+(.+)$/gm;
  for (const m of output.matchAll(gradleKtRe)) {
    add({ file: m[1], line: +m[2], col: +m[3], severity: 'error', message: m[4], raw: m[0] });
  }

  // Generic: error: ...  or  ERROR: ...  or  [ERROR] ...
  const genericRe = /^(?:\[ERROR\]|error|ERROR):\s+(.+)$/gm;
  for (const m of output.matchAll(genericRe)) {
    add({ severity: 'error', message: m[1], raw: m[0] });
  }

  return errors;
}

export function summarizeErrors(results: BuildResult[]): string {
  const failed = results.filter(r => !r.success);
  if (failed.length === 0) return '';

  const lines: string[] = [];
  for (const r of failed) {
    lines.push(`=== ${r.script.label} errors ===`);
    if (r.errors.length > 0) {
      for (const e of r.errors.filter(e => e.severity === 'error').slice(0, 30)) {
        const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
        lines.push(loc ? `${loc}: ${e.message}` : e.message);
      }
    } else {
      // Fallback — last 40 lines of raw output
      lines.push(r.output.split('\n').filter(l => l.trim()).slice(-40).join('\n'));
    }
    lines.push('');
  }
  return lines.join('\n');
}
