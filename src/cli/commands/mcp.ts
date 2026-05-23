import chalk from 'chalk';
import inquirer from 'inquirer';
import boxen from 'boxen';
import yaml from 'js-yaml';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, access, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../../core/config.js';
import { McpManager } from '../../core/mcp.js';
import type { McpServerConfig } from '../../core/mcp.js';
import { logger } from '../../utils/logger.js';
import { getApiKey } from '../../core/config.js';
import { initClient } from '../../core/api.js';

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────

interface EnvVarSpec {
  name: string;
  description: string;
  required: boolean;
  example?: string;
  sensitive: boolean;
}

interface PackageAnalysis {
  name: string;
  description: string;
  cloneDir?: string;           // set when installed from git
  npmPackage?: string;         // set when installed via npx
  runCommand: { command: string; args: string[] };
  envVars: EnvVarSpec[];
  requiresAuth: boolean;
  readme: string;
  installNote?: string;
}

// ─── URL parser ────────────────────────────────────────────────────────────

interface ParsedUrl {
  type: 'github' | 'bitbucket' | 'gitlab' | 'npm' | 'local';
  owner?: string;
  repo?: string;
  branch?: string;
  subpath?: string;
  raw: string;
}

function parseSourceUrl(input: string): ParsedUrl {
  const trimmed = input.trim();

  // npm: explicit prefix or plain package name without slashes/dots
  if (trimmed.startsWith('npm:')) {
    return { type: 'npm', raw: trimmed.replace(/^npm:/, '') };
  }

  // GitHub
  const gh = trimmed.match(/github\.com\/([^/]+)\/([^/?#]+)(?:\/tree\/([^/]+)(?:\/(.+?))?)?[/?#]?$/i);
  if (gh) {
    return {
      type: 'github',
      owner: gh[1],
      repo: gh[2].replace(/\.git$/, ''),
      branch: gh[3] ?? 'main',
      subpath: gh[4]?.replace(/\/$/, '') ?? '',
      raw: trimmed,
    };
  }

  // GitLab
  const gl = trimmed.match(/gitlab\.com\/([^/]+)\/([^/?#]+)(?:\/-\/tree\/([^/]+)(?:\/(.+?))?)?[/?#]?$/i);
  if (gl) {
    return {
      type: 'gitlab',
      owner: gl[1],
      repo: gl[2].replace(/\.git$/, ''),
      branch: gl[3] ?? 'main',
      subpath: gl[4]?.replace(/\/$/, '') ?? '',
      raw: trimmed,
    };
  }

  // Bitbucket
  const bb = trimmed.match(/bitbucket\.org\/([^/]+)\/([^/?#]+)(?:\/src\/([^/]+)(?:\/(.+?))?)?[/?#]?$/i);
  if (bb) {
    return {
      type: 'bitbucket',
      owner: bb[1],
      repo: bb[2].replace(/\.git$/, ''),
      branch: bb[3] ?? 'main',
      subpath: bb[4]?.replace(/\/$/, '') ?? '',
      raw: trimmed,
    };
  }

  if (trimmed.startsWith('./') || trimmed.startsWith('/')) {
    return { type: 'local', raw: trimmed };
  }

  // Fallback: treat as npm package name
  return { type: 'npm', raw: trimmed };
}

// ─── File / HTTP helpers ───────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.text();
  } catch { return null; }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const text = await fetchText(url);
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

// ─── Env var detection ─────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = /key|token|secret|password|pass|credential|auth|api_key/i;
const COMMON_NOISE = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'NODE', 'NPM', 'TRUE', 'FALSE', 'NULL', 'NODE_ENV']);

function extractEnvVars(readme: string, packageJson?: Record<string, unknown>): EnvVarSpec[] {
  const vars = new Map<string, EnvVarSpec>();

  const add = (name: string, desc = '', example?: string) => {
    if (COMMON_NOISE.has(name) || name.length < 3) return;
    if (!vars.has(name)) {
      vars.set(name, {
        name,
        description: desc,
        required: true,
        example,
        sensitive: SENSITIVE_PATTERNS.test(name),
      });
    } else if (desc && !vars.get(name)!.description) {
      vars.get(name)!.description = desc;
    }
  };

  // Code blocks: KEY=value
  const codeBlocks = readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g);
  for (const [, block] of codeBlocks) {
    for (const [, name, example] of block.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/gm)) {
      add(name, '', example.trim().replace(/["']/g, ''));
    }
    for (const [, name, example] of block.matchAll(/"([A-Z][A-Z0-9_]{2,})"\s*:\s*"([^"]+)"/g)) {
      add(name, '', example);
    }
  }

  // process.env references
  for (const [, name] of readme.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) {
    add(name);
  }

  // ${VAR} patterns
  for (const [, name] of readme.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) {
    add(name);
  }

  // Markdown list: "- VAR_NAME: description"
  for (const [, name, desc] of readme.matchAll(/[-*]\s+`?([A-Z][A-Z0-9_]{2,})`?\s*[:\-–]\s*([^\n]+)/g)) {
    add(name, desc.trim());
  }

  return [...vars.values()];
}

// ─── AI enrichment (optional, only if API key available) ──────────────────

async function enrichWithAI(
  readme: string,
  rawVars: EnvVarSpec[],
  apiKey: string,
  model: string
): Promise<EnvVarSpec[]> {
  if (!apiKey || rawVars.length === 0) return rawVars;

  try {
    const client = initClient({ apiKey, model });
    const varNames = rawVars.map(v => v.name).join(', ');

    const res = await client.chat([
      {
        role: 'system',
        content: 'You are analyzing MCP server documentation to extract setup requirements. Be concise.',
      },
      {
        role: 'user',
        content: `README excerpt:\n\`\`\`\n${readme.slice(0, 3000)}\n\`\`\`\n\nDetected env vars: ${varNames}\n\nFor each env var provide a one-line description and whether it is required or optional.\nRespond ONLY as JSON array: [{"name":"VAR","description":"...","required":true}]`,
      },
    ], model, { temperature: 0 });

    const match = (res.content ?? '').match(/\[[\s\S]+\]/);
    if (!match) return rawVars;

    const enriched = JSON.parse(match[0]) as Array<{ name: string; description: string; required: boolean }>;
    return rawVars.map(v => {
      const found = enriched.find(e => e.name === v.name);
      return found ? { ...v, description: found.description, required: found.required } : v;
    });
  } catch {
    return rawVars;
  }
}

// ─── Git clone + local analysis ────────────────────────────────────────────

function buildCloneUrl(parsed: ParsedUrl, creds?: { token?: string; username?: string; password?: string }): string {
  if (!creds) {
    switch (parsed.type) {
      case 'github':    return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
      case 'gitlab':    return `https://gitlab.com/${parsed.owner}/${parsed.repo}.git`;
      case 'bitbucket': return `https://bitbucket.org/${parsed.owner}/${parsed.repo}.git`;
      default: throw new Error(`Cannot clone from type: ${parsed.type}`);
    }
  }

  // Authenticated URLs
  switch (parsed.type) {
    case 'github':
      return `https://${creds.token}@github.com/${parsed.owner}/${parsed.repo}.git`;
    case 'gitlab':
      return `https://oauth2:${creds.token}@gitlab.com/${parsed.owner}/${parsed.repo}.git`;
    case 'bitbucket':
      return `https://${creds.username}:${creds.password}@bitbucket.org/${parsed.owner}/${parsed.repo}.git`;
    default:
      throw new Error(`Cannot clone from type: ${parsed.type}`);
  }
}

const AUTH_ERROR_RE = /authentication failed|could not read username|repository not found|403|401|access denied|permission denied/i;

async function promptGitCredentials(parsed: ParsedUrl): Promise<{ token?: string; username?: string; password?: string }> {
  logger.newline();
  logger.warn(`Access denied — "${parsed.owner}/${parsed.repo}" appears to be a private repository.`);
  logger.newline();

  if (parsed.type === 'bitbucket') {
    const { username, password } = await inquirer.prompt([
      { type: 'input',    name: 'username', message: 'Bitbucket username:',     validate: (v: string) => !!v.trim() || 'Required' },
      { type: 'password', name: 'password', message: 'Bitbucket App Password:', validate: (v: string) => !!v.trim() || 'Required' },
    ]);
    return { username, password };
  }

  const providerName = parsed.type === 'gitlab' ? 'GitLab' : 'GitHub';
  const tokenHint = parsed.type === 'gitlab'
    ? '(Settings → Access Tokens → read_repository)'
    : '(github.com/settings/tokens — repo scope)';

  const { token } = await inquirer.prompt([{
    type: 'password',
    name: 'token',
    message: `${providerName} Personal Access Token ${chalk.gray(tokenHint)}:`,
    validate: (v: string) => !!v.trim() || 'Required',
  }]);

  return { token };
}

async function cloneWithAuthRetry(parsed: ParsedUrl, targetDir: string): Promise<{ creds?: { token?: string; username?: string; password?: string } }> {
  const cloneUrl = buildCloneUrl(parsed);
  const shellOpts = { shell: true };

  try {
    await execFileAsync('git', ['clone', '--depth', '1', '--quiet', cloneUrl, targetDir], shellOpts);
    return {};
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const msg = err.message + (err.stderr ?? '');
    if (!AUTH_ERROR_RE.test(msg)) throw e;

    // Prompt for credentials and retry
    const creds = await promptGitCredentials(parsed);
    const authUrl = buildCloneUrl(parsed, creds);

    const retrySpinner = logger.spinner('Retrying with credentials...').start();
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--quiet', authUrl, targetDir], shellOpts);
      retrySpinner.succeed('Authenticated successfully');
      return { creds };
    } catch (e2) {
      retrySpinner.fail(`Authentication failed: ${(e2 as Error).message}`);
      throw e2;
    }
  }
}

async function cloneAndAnalyze(parsed: ParsedUrl, apiKey: string, model: string): Promise<PackageAnalysis> {
  const mcpDir = join(homedir(), '.didev', 'mcp');
  const repoName = parsed.repo!;
  const targetDir = join(mcpDir, repoName);

  await mkdir(mcpDir, { recursive: true });

  // Clone or pull
  const cloneSpinner = logger.spinner('Cloning repository...').start();
  let savedCreds: { token?: string; username?: string; password?: string } | undefined;

  try {
    if (await fileExists(join(targetDir, '.git'))) {
      await execFileAsync('git', ['-C', targetDir, 'pull', '--ff-only', '--quiet'], { shell: true });
      cloneSpinner.succeed(`Repository updated: ${chalk.dim(targetDir)}`);
    } else {
      cloneSpinner.stop();
      const result = await cloneWithAuthRetry(parsed, targetDir);
      savedCreds = result.creds;
      logger.success(`Cloned to ${chalk.dim(targetDir)}`);

      // Save git credentials to global ~/.didev/.env so future pulls work
      if (savedCreds) {
        const globalEnvPath = join(homedir(), '.didev', '.env');
        await mkdir(join(homedir(), '.didev'), { recursive: true });
        let existing = '';
        try { existing = await readFile(globalEnvPath, 'utf-8'); } catch {}
        const lines = existing.split('\n').filter(Boolean);
        const varName = `DIDEV_GIT_${parsed.type.toUpperCase()}_TOKEN`;
        const value = savedCreds.token ?? (savedCreds.username ? `${savedCreds.username}:${savedCreds.password}` : '');
        if (value) {
          const idx = lines.findIndex(l => l.startsWith(`${varName}=`));
          if (idx >= 0) lines[idx] = `${varName}=${value}`;
          else lines.push(`${varName}=${value}`);
          await writeFile(globalEnvPath, lines.join('\n') + '\n', 'utf-8');
          logger.dim(`Git credentials saved to ${globalEnvPath}`);
        }
      }
    }
  } catch (e) {
    cloneSpinner.fail(`Clone failed: ${(e as Error).message}`);
    throw e;
  }

  // Detect language
  let language: 'node' | 'python' | 'unknown' = 'unknown';
  let pkg: Record<string, unknown> | null = null;

  try {
    pkg = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8')) as Record<string, unknown>;
    language = 'node';
  } catch {}

  if (language === 'unknown') {
    for (const f of ['requirements.txt', 'pyproject.toml', 'setup.py']) {
      if (await fileExists(join(targetDir, f))) { language = 'python'; break; }
    }
  }

  // Install & build (shell:true so npm.cmd / pip are found on Windows)
  const shellOpts = { cwd: targetDir, shell: true };

  if (language === 'node') {
    const installSpinner = logger.spinner('Installing dependencies...').start();
    try {
      await execFileAsync('npm', ['install', '--prefer-offline', '--silent'], shellOpts);
      installSpinner.succeed('Dependencies installed');
    } catch (e) {
      installSpinner.warn(`npm install: ${(e as Error).message}`);
    }

    const scripts = pkg?.scripts as Record<string, string> | undefined;
    if (scripts?.build) {
      const buildSpinner = logger.spinner('Building...').start();
      try {
        await execFileAsync('npm', ['run', 'build'], shellOpts);
        buildSpinner.succeed('Build complete');
      } catch (e) {
        buildSpinner.warn(`Build: ${(e as Error).message}`);
      }
    }
  } else if (language === 'python') {
    if (await fileExists(join(targetDir, 'requirements.txt'))) {
      const installSpinner = logger.spinner('Installing Python dependencies...').start();
      try {
        await execFileAsync('pip', ['install', '-r', 'requirements.txt', '-q'], shellOpts);
        installSpinner.succeed('Python dependencies installed');
      } catch (e) {
        installSpinner.warn(`pip install: ${(e as Error).message}`);
      }
    }
  }

  // Find entry point
  let entryPoint = '';
  let command = 'node';
  const cmdArgs: string[] = [];

  if (language === 'node' && pkg) {
    const bin = pkg['bin'];
    if (bin && typeof bin === 'object' && bin !== null) {
      const first = Object.values(bin as Record<string, string>)[0];
      if (first) entryPoint = join(targetDir, first);
    } else if (typeof bin === 'string') {
      entryPoint = join(targetDir, bin);
    } else if (typeof pkg['main'] === 'string') {
      entryPoint = join(targetDir, pkg['main']);
    }

    if (!entryPoint) {
      for (const candidate of ['dist/index.js', 'build/index.js', 'index.js', 'src/index.js', 'dist/main.js', 'build/main.js']) {
        if (await fileExists(join(targetDir, candidate))) {
          entryPoint = join(targetDir, candidate);
          break;
        }
      }
    }

    command = 'node';
    if (entryPoint) cmdArgs.push(entryPoint);
  } else if (language === 'python') {
    for (const candidate of ['main.py', 'server.py', 'app.py', 'src/main.py', '__main__.py']) {
      if (await fileExists(join(targetDir, candidate))) {
        entryPoint = join(targetDir, candidate);
        break;
      }
    }
    command = 'python';
    if (entryPoint) cmdArgs.push(entryPoint);
  }

  // Read README for env var detection
  let readme = '';
  try { readme = await readFile(join(targetDir, 'README.md'), 'utf-8'); } catch {}

  let envVars = extractEnvVars(readme, pkg ?? {});
  if (envVars.length > 0 && apiKey) {
    const enrichSpinner = logger.spinner('Analyzing requirements with AI...').start();
    envVars = await enrichWithAI(readme, envVars, apiKey, model);
    enrichSpinner.stop();
  }

  const shortName = repoName.replace(/^mcp-server-/, '').replace(/^mcp-/, '');

  return {
    name: shortName,
    description: typeof pkg?.description === 'string' ? pkg.description : `MCP server from ${parsed.owner}/${parsed.repo}`,
    cloneDir: targetDir,
    runCommand: { command, args: cmdArgs },
    envVars,
    requiresAuth: envVars.some(v => v.required),
    readme: readme.slice(0, 1000),
    installNote: !entryPoint
      ? `⚠ Could not detect entry point. Check ${targetDir} and set command/args in .didev/config.yaml manually.`
      : undefined,
  };
}

// ─── npm package analysis ──────────────────────────────────────────────────

async function analyzeNpmPackage(pkgName: string, apiKey: string, model: string): Promise<PackageAnalysis> {
  const spinner = logger.spinner(`Fetching npm info for ${chalk.cyan(pkgName)}...`).start();

  // npm registry URL — scoped packages need @scope%2Fpkg format
  const registryUrl = pkgName.startsWith('@')
    ? `https://registry.npmjs.org/${pkgName.replace('/', '%2F')}/latest`
    : `https://registry.npmjs.org/${pkgName}/latest`;

  const data = await fetchJson<{ readme?: string; description?: string; name?: string }>(registryUrl);
  const readme = data?.readme ?? '';
  const description = data?.description ?? pkgName;

  if (data) {
    spinner.succeed(`Found: ${chalk.gray(description)}`);
  } else {
    spinner.warn(`Package "${pkgName}" not found on npm — will try npx anyway`);
  }

  let envVars = extractEnvVars(readme, {});
  if (envVars.length > 0 && apiKey) {
    const enrichSpinner = logger.spinner('Analyzing requirements with AI...').start();
    envVars = await enrichWithAI(readme, envVars, apiKey, model);
    enrichSpinner.stop();
  }

  const shortName = pkgName.replace(/^@[^/]+\/server-/, '').replace(/^mcp-server-/, '').replace(/^mcp-/, '');
  return {
    name: shortName,
    description,
    npmPackage: pkgName,
    runCommand: { command: 'npx', args: ['-y', pkgName] },
    envVars,
    requiresAuth: envVars.some(v => v.required),
    readme: readme.slice(0, 1000),
  };
}

// ─── Main analysis router ──────────────────────────────────────────────────

async function analyzePackage(parsed: ParsedUrl, apiKey: string, model: string): Promise<PackageAnalysis> {
  if (parsed.type === 'npm') {
    return analyzeNpmPackage(parsed.raw, apiKey, model);
  }

  if (parsed.type === 'local') {
    // Treat local path as a pre-cloned repo — analyze in place
    return analyzeLocalDir(parsed.raw, apiKey, model);
  }

  // GitHub / GitLab / Bitbucket → clone and analyze
  return cloneAndAnalyze(parsed, apiKey, model);
}

async function analyzeLocalDir(dir: string, apiKey: string, model: string): Promise<PackageAnalysis> {
  let pkg: Record<string, unknown> | null = null;
  try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')); } catch {}

  let readme = '';
  try { readme = await readFile(join(dir, 'README.md'), 'utf-8'); } catch {}

  let envVars = extractEnvVars(readme, pkg ?? {});
  if (envVars.length > 0 && apiKey) {
    envVars = await enrichWithAI(readme, envVars, apiKey, model);
  }

  let entryPoint = '';
  if (pkg) {
    const bin = pkg['bin'];
    if (typeof bin === 'object' && bin !== null) {
      const first = Object.values(bin as Record<string, string>)[0];
      if (first) entryPoint = join(dir, first);
    } else if (typeof bin === 'string') {
      entryPoint = join(dir, bin);
    } else if (typeof pkg['main'] === 'string') {
      entryPoint = join(dir, pkg['main']);
    }
  }
  if (!entryPoint) {
    for (const c of ['dist/index.js', 'index.js', 'src/index.js', 'main.py', 'server.py']) {
      if (await fileExists(join(dir, c))) { entryPoint = join(dir, c); break; }
    }
  }

  const command = entryPoint.endsWith('.py') ? 'python' : 'node';
  return {
    name: dir.split('/').pop() ?? 'local-server',
    description: typeof pkg?.description === 'string' ? pkg.description : `Local MCP server at ${dir}`,
    cloneDir: dir,
    runCommand: { command, args: entryPoint ? [entryPoint] : [] },
    envVars,
    requiresAuth: envVars.some(v => v.required),
    readme: readme.slice(0, 1000),
  };
}

// ─── Interactive env var collection ───────────────────────────────────────

async function promptForEnvVars(vars: EnvVarSpec[]): Promise<Record<string, string>> {
  if (vars.length === 0) return {};

  logger.newline();
  logger.bold('Required configuration:');
  logger.newline();

  const collected: Record<string, string> = {};

  for (const v of vars) {
    const label = v.required ? chalk.red('*') : chalk.gray('?');
    const desc = v.description ? chalk.gray(` — ${v.description}`) : '';
    const example = v.example ? chalk.gray(` (e.g. ${v.example})`) : '';

    const { value } = await inquirer.prompt([{
      type: v.sensitive ? 'password' : 'input',
      name: 'value',
      message: `${label} ${chalk.bold(v.name)}${desc}${example}:`,
      validate: (val: string) => {
        if (v.required && !val.trim()) return `${v.name} is required`;
        return true;
      },
    }]);

    if (value.trim()) {
      collected[v.name] = value.trim();
    }
  }

  return collected;
}

// ─── Save helpers ──────────────────────────────────────────────────────────

async function appendServer(server: McpServerConfig): Promise<void> {
  const config = await loadConfig();
  const servers = config.mcp?.servers ?? [];
  const idx = servers.findIndex(s => s.name === server.name);
  if (idx >= 0) servers[idx] = server;
  else servers.push(server);
  config.mcp = { servers };

  const configPath = join(process.cwd(), '.didev', 'config.yaml');
  await mkdir(join(process.cwd(), '.didev'), { recursive: true });

  const toSave = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const api = toSave['api'] as Record<string, unknown> | undefined;
  if (api?.['apiKey'] && typeof api['apiKey'] === 'string' && !api['apiKey'].includes('${')) {
    api['apiKey'] = '${DEEPSEEK_API_KEY}';
  }
  await writeFile(configPath, yaml.dump(toSave, { indent: 2 }), 'utf-8');
}

// ─── Public commands ───────────────────────────────────────────────────────

export async function runMcpAdd(sourceUrl?: string): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);
  const model = config.api.model;

  logger.banner('didev mcp add', sourceUrl ? 'Installing from URL' : 'Add MCP Server');

  let analysis: PackageAnalysis;

  if (sourceUrl) {
    // ── URL / git mode ───────────────────────────────────────────────────────
    let parsed: ParsedUrl;
    try {
      parsed = parseSourceUrl(sourceUrl);
    } catch (e) {
      logger.error((e as Error).message);
      process.exit(1);
    }

    const typeLabel = parsed.type === 'npm'
      ? 'npm package'
      : `${parsed.type}${parsed.owner ? ` · ${parsed.owner}/${parsed.repo}` : ''}`;

    logger.info(`Source: ${chalk.cyan(sourceUrl)}`);
    logger.dim(`Type: ${typeLabel}`);
    logger.newline();

    analysis = await analyzePackage(parsed, apiKey, model);

  } else {
    // ── Wizard mode ──────────────────────────────────────────────────────────
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'How do you want to add a server?',
      choices: [
        { name: 'From GitHub / GitLab / Bitbucket URL  (clones & builds)', value: 'url' },
        { name: 'From npm package name  (runs via npx)', value: 'npm' },
        { name: 'Choose from popular servers', value: 'popular' },
      ],
    }]);

    if (choice === 'url' || choice === 'npm') {
      const { input } = await inquirer.prompt([{
        type: 'input',
        name: 'input',
        message: choice === 'url' ? 'Paste Git URL:' : 'Package name (e.g. @scope/mcp-server):',
        validate: (v: string) => v.trim().length > 3 || 'Required',
      }]);
      return runMcpAdd(input.trim());
    }

    return runMcpAddWizard(config, apiKey, model);
  }

  // ── Show analysis result ─────────────────────────────────────────────────
  const runCmd = [analysis.runCommand.command, ...analysis.runCommand.args.map(a =>
    a.length > 60 ? `...${a.slice(-50)}` : a   // truncate long absolute paths for display
  )].join(' ');

  const authStatus = analysis.requiresAuth
    ? chalk.yellow(`⚠  Requires ${analysis.envVars.filter(v => v.required).length} env var(s)`)
    : chalk.green('✓  No auth required — installs automatically');

  const locationLine = analysis.cloneDir
    ? `\n${chalk.bold('Location:')} ${chalk.dim(analysis.cloneDir)}`
    : '';

  console.log(
    boxen(
      chalk.bold(analysis.name) +
      (analysis.description ? `\n${chalk.gray(analysis.description)}` : '') +
      `\n\n${authStatus}` +
      locationLine +
      `\n\n${chalk.bold('Run:')} ${chalk.cyan(runCmd)}` +
      (analysis.envVars.length > 0
        ? `\n${chalk.bold('Vars:')} ${analysis.envVars.map(v =>
            v.required ? chalk.red(v.name) : chalk.gray(v.name)
          ).join(', ')}`
        : '') +
      (analysis.installNote ? `\n\n${chalk.yellow(analysis.installNote)}` : ''),
      { padding: 1, borderColor: analysis.requiresAuth ? 'yellow' : 'green', borderStyle: 'round' }
    )
  );

  // ── Warn if entry point not found ────────────────────────────────────────
  if (analysis.cloneDir && analysis.runCommand.args.length === 0) {
    logger.warn('Entry point not detected automatically.');
    logger.dim(`Edit .didev/config.yaml after saving to set the correct command.`);
    logger.newline();
  }

  // ── Confirm server name ──────────────────────────────────────────────────
  const { serverName } = await inquirer.prompt([{
    type: 'input',
    name: 'serverName',
    message: 'Server name in didev config:',
    default: analysis.name,
    validate: (v: string) => /^[a-z0-9_-]+$/.test(v) || 'Lowercase letters, numbers, - or _',
  }]);

  // ── Collect env vars ─────────────────────────────────────────────────────
  let collectedEnv: Record<string, string> = {};
  if (analysis.requiresAuth) {
    collectedEnv = await promptForEnvVars(analysis.envVars.filter(v => v.required));

    const optional = analysis.envVars.filter(v => !v.required);
    if (optional.length > 0) {
      const { configureOptional } = await inquirer.prompt([{
        type: 'confirm',
        name: 'configureOptional',
        message: `Configure ${optional.length} optional var(s)?`,
        default: false,
      }]);
      if (configureOptional) {
        const optEnv = await promptForEnvVars(optional);
        Object.assign(collectedEnv, optEnv);
      }
    }
  }

  // ── Build server config ───────────────────────────────────────────────────
  const serverConfig: McpServerConfig = {
    name: serverName as string,
    command: analysis.runCommand.command,
    args: analysis.runCommand.args,
    ...(Object.keys(collectedEnv).length > 0 ? {
      env: Object.fromEntries(
        Object.keys(collectedEnv).map(k => [k, `\${${k}}`])
      ),
    } : {}),
  };

  // ── Save env values to .didev/.env (gitignored) ──────────────────────────
  if (Object.keys(collectedEnv).length > 0) {
    const envPath = join(process.cwd(), '.didev', '.env');
    let existing = '';
    try { existing = await readFile(envPath, 'utf-8'); } catch {}

    const lines = existing.split('\n').filter(Boolean);
    for (const [k, v] of Object.entries(collectedEnv)) {
      const idx = lines.findIndex(l => l.startsWith(`${k}=`));
      if (idx >= 0) lines[idx] = `${k}=${v}`;
      else lines.push(`${k}=${v}`);
    }
    await writeFile(envPath, lines.join('\n') + '\n', 'utf-8');
    logger.info('Credentials saved to .didev/.env (gitignored)');

    for (const [k, v] of Object.entries(collectedEnv)) {
      process.env[k] = v;
    }
  }

  // ── Test connection ───────────────────────────────────────────────────────
  if (analysis.runCommand.args.length > 0 || analysis.npmPackage) {
    const testSpinner = logger.spinner(`Testing connection to "${serverName}"...`).start();
    const mgr = new McpManager();
    let testOk = false;

    try {
      await mgr.connectOne(serverConfig);
      const summary = mgr.summary().find(s => s.server === serverName);
      const toolCount = summary?.tools.length ?? 0;
      testOk = true;
      testSpinner.succeed(chalk.green(`Connected — ${toolCount} tool(s) available`));
      if (summary) summary.tools.forEach(t => logger.dim(`    • ${t}`));
    } catch (e) {
      testSpinner.fail(chalk.red(`Connection failed: ${(e as Error).message}`));
      const { saveAnyway } = await inquirer.prompt([{
        type: 'confirm',
        name: 'saveAnyway',
        message: 'Save config anyway?',
        default: true,
      }]);
      if (!saveAnyway) { await mgr.disconnectAll(); return; }
    } finally {
      await mgr.disconnectAll();
    }

    // ── Save to config ──────────────────────────────────────────────────────
    await appendServer(serverConfig);
    logger.newline();
    logger.success(`"${serverName}" added to .didev/config.yaml`);
    if (testOk) logger.dim('Now available in: didev chat · didev agent');
  } else {
    // No entry point found — save anyway with a note
    await appendServer(serverConfig);
    logger.newline();
    logger.success(`"${serverName}" added to .didev/config.yaml`);
    logger.warn('Entry point not set — edit config before using this server.');
  }
}

// Wizard for popular npm-based servers
async function runMcpAddWizard(
  config: Awaited<ReturnType<typeof loadConfig>>,
  apiKey: string,
  model: string
): Promise<void> {
  const POPULAR = [
    { label: 'Filesystem — read/write local files', config: { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } },
    { label: 'GitHub — repos, issues, PRs', config: { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' } } },
    { label: 'Brave Search — web search', config: { name: 'brave-search', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } } },
    { label: 'PostgreSQL — query your DB', config: { name: 'postgres', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'] } },
    { label: 'SQLite — local database', config: { name: 'sqlite', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', './db.sqlite'] } },
    { label: 'Puppeteer — browser automation', config: { name: 'puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] } },
    { label: 'Memory — persistent knowledge graph', config: { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
    { label: 'Slack — channels and messages', config: { name: 'slack', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}', SLACK_TEAM_ID: '${SLACK_TEAM_ID}' } } },
  ];

  const { idx } = await inquirer.prompt([{
    type: 'list',
    name: 'idx',
    message: 'Choose a server:',
    choices: POPULAR.map((s, i) => ({ name: s.label, value: i })),
    pageSize: 10,
  }]);

  const chosen = POPULAR[idx as number];
  await appendServer(chosen.config as McpServerConfig);
  logger.success(`"${chosen.config.name}" added. Test with: didev mcp test ${chosen.config.name}`);
}

// ─── Other commands ────────────────────────────────────────────────────────

export async function runMcpList(): Promise<void> {
  const config = await loadConfig();
  const servers = config.mcp?.servers ?? [];

  logger.banner('didev mcp', 'MCP Server Management');

  if (servers.length === 0) {
    logger.warn('No MCP servers configured.');
    logger.dim(`Add one: ${chalk.cyan('didev mcp add https://github.com/owner/repo.git')}`);
    logger.dim(`Or pick from list: ${chalk.cyan('didev mcp add')}`);
    return;
  }

  logger.bold(`Configured servers (${servers.length}):`);
  logger.newline();

  for (const srv of servers) {
    const status = srv.enabled === false ? chalk.gray('[disabled]') : chalk.green('[enabled]');
    const cmd = [srv.command, ...(srv.args ?? [])].join(' ');
    console.log(`  ${status} ${chalk.bold(srv.name)}`);
    logger.dim(`         ${cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd}`);
    if (srv.env && Object.keys(srv.env).length > 0) {
      logger.dim(`         env: ${chalk.yellow(Object.keys(srv.env).join(', '))}`);
    }
    logger.newline();
  }

  logger.dim(`Test: ${chalk.cyan('didev mcp test')}`);
  logger.dim(`Add:  ${chalk.cyan('didev mcp add <git-url>')}`);
}

export async function runMcpTest(serverName?: string): Promise<void> {
  const config = await loadConfig();

  // Load .didev/.env
  try {
    const envText = await readFile(join(process.cwd(), '.didev', '.env'), 'utf-8');
    for (const line of envText.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {}

  const servers = (config.mcp?.servers ?? []).filter(
    s => s.enabled !== false && (!serverName || s.name === serverName)
  );

  if (servers.length === 0) {
    logger.warn(serverName ? `Server "${serverName}" not found.` : 'No enabled servers configured.');
    return;
  }

  logger.banner('didev mcp test', 'Testing MCP connections');

  for (const srv of servers) {
    const spinner = logger.spinner(`Connecting to "${srv.name}"...`).start();
    const mgr = new McpManager();
    try {
      await mgr.connectOne(srv);
      const summary = mgr.summary().find(s => s.server === srv.name);
      const tools = summary?.tools ?? [];
      spinner.succeed(`${chalk.bold(srv.name)} — ${chalk.green(tools.length + ' tools')}`);
      tools.forEach(t => logger.dim(`    • ${t}`));
    } catch (e) {
      spinner.fail(`${chalk.bold(srv.name)} — ${chalk.red((e as Error).message)}`);
    } finally {
      await mgr.disconnectAll();
    }
    logger.newline();
  }
}

export async function runMcpRemove(serverName: string): Promise<void> {
  const config = await loadConfig();
  const servers = config.mcp?.servers ?? [];
  const idx = servers.findIndex(s => s.name === serverName);
  if (idx === -1) { logger.error(`Server "${serverName}" not found.`); return; }

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `Remove "${serverName}"?`,
    default: false,
  }]);
  if (!confirm) { logger.info('Cancelled.'); return; }

  servers.splice(idx, 1);
  config.mcp = { servers };

  const configPath = join(process.cwd(), '.didev', 'config.yaml');
  const toSave = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const api = toSave['api'] as Record<string, unknown>;
  if (api?.['apiKey'] && !String(api['apiKey']).includes('${')) api['apiKey'] = '${DEEPSEEK_API_KEY}';
  await writeFile(configPath, yaml.dump(toSave, { indent: 2 }), 'utf-8');
  logger.success(`"${serverName}" removed.`);
}
