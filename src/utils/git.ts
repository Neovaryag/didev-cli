import { execFile } from 'child_process';
import { promisify } from 'util';
import { withTimeout } from './resilience.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;

async function git(args: string[], cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await withTimeout(
      execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }),
      GIT_TIMEOUT_MS,
      `git ${args[0]}`
    );
    return stdout.trim();
  } catch (e: unknown) {
    const err = e as { code?: number; stderr?: string; message?: string };
    if (err.code === 128 || (err.message ?? '').includes('not a git repository')) return '';
    throw new Error(`git ${args[0]} failed: ${err.stderr ?? err.message}`);
  }
}

export async function isGitRepo(cwd = process.cwd()): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return result === 'true';
}

export async function getGitRoot(cwd = process.cwd()): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], cwd);
  return result || null;
}

export async function getChangedFiles(cwd = process.cwd()): Promise<string[]> {
  const output = await git(['diff', '--name-only', 'HEAD'], cwd);
  const staged = await git(['diff', '--name-only', '--cached'], cwd);
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd);
  const all = [...new Set([...output.split('\n'), ...staged.split('\n'), ...untracked.split('\n')])]
    .filter(Boolean);
  return all;
}

export async function getDiff(base = 'main', cwd = process.cwd()): Promise<string> {
  return git(['diff', `${base}...HEAD`], cwd);
}

export async function getCurrentBranch(cwd = process.cwd()): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export async function getRemoteUrl(cwd = process.cwd()): Promise<string> {
  return git(['remote', 'get-url', 'origin'], cwd);
}

export async function createBranch(name: string, cwd = process.cwd()): Promise<void> {
  await git(['checkout', '-b', name], cwd);
}

export async function getRecentCommits(n = 10, cwd = process.cwd()): Promise<string> {
  return git(['log', `--oneline`, `-${n}`], cwd);
}
