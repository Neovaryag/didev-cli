import { readFile, writeFile, mkdir, readdir, stat, access } from 'fs/promises';
import { join, dirname, normalize, resolve, sep, extname } from 'path';
import { createPatch } from 'diff';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface FileChange {
  path: string;
  content: string;
  originalContent?: string;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function assertSafePath(path: string, rootDir: string): string {
  const root = resolve(rootDir);
  const full = resolve(root, path);
  if (!full.startsWith(root + sep) && full !== root) {
    throw new Error(`Access denied: path "${path}" escapes project root`);
  }
  return full;
}

export async function readProjectFile(path: string, rootDir = process.cwd()): Promise<string> {
  const fullPath = assertSafePath(path, rootDir);
  return readFile(fullPath, 'utf-8');
}

export async function writeProjectFile(
  path: string,
  content: string,
  rootDir = process.cwd()
): Promise<void> {
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_SIZE) {
    throw new Error(`Refusing to write ${path}: content is ${(byteLength / 1024 / 1024).toFixed(1)}MB (limit 10MB)`);
  }
  const fullPath = assertSafePath(path, rootDir);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

export async function listDirectory(
  dirPath: string,
  rootDir = process.cwd()
): Promise<Array<{ name: string; type: 'file' | 'dir'; size?: number }>> {
  const fullPath = join(rootDir, dirPath);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const info: { name: string; type: 'file' | 'dir'; size?: number } = {
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    };
    if (e.isFile()) {
      try {
        const s = await stat(join(fullPath, e.name));
        info.size = s.size;
      } catch (statErr) {
        logger.debug(`listDirectory: stat failed for ${e.name}: ${(statErr as Error).message}`);
      }
    }
    result.push(info);
  }
  return result;
}

export function renderDiff(filePath: string, oldContent: string, newContent: string): string {
  const patch = createPatch(filePath, oldContent, newContent, 'original', 'modified');
  const lines = patch.split('\n');
  const rendered: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      rendered.push(chalk.bold(line));
    } else if (line.startsWith('@@')) {
      rendered.push(chalk.cyan(line));
    } else if (line.startsWith('+')) {
      rendered.push(chalk.green(line));
    } else if (line.startsWith('-')) {
      rendered.push(chalk.red(line));
    } else {
      rendered.push(chalk.gray(line));
    }
  }

  return rendered.join('\n');
}

export async function applyFileChanges(
  changes: FileChange[],
  rootDir = process.cwd(),
  showDiff = true
): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const change of changes) {
    const fullPath = join(rootDir, change.path);
    let originalContent = '';

    if (await exists(fullPath)) {
      originalContent = await readFile(fullPath, 'utf-8');
    }

    if (showDiff) {
      logger.newline();
      logger.bold(`File: ${change.path}`);
      console.log(renderDiff(change.path, originalContent, change.content));
    }

    applied.push(change.path);
    await writeProjectFile(change.path, change.content, rootDir);
    logger.success(`Written: ${change.path}`);
  }

  return { applied, skipped };
}

// Extract file changes from AI markdown response
// Looks for ```lang\n...``` blocks preceded by a filename hint
export function extractFileChanges(aiResponse: string): FileChange[] {
  const changes: FileChange[] = [];

  // Pattern: optional filename comment before code block
  const pattern = /(?:(?:^|\n)(?:#+\s*)?(?:File|файл)?:?\s*[`]?([^\n`]+)[`]?\s*\n)?```(?:\w+)?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(aiResponse)) !== null) {
    const possiblePath = match[1]?.trim();
    const content = match[2];

    if (possiblePath && isValidFilePath(possiblePath) && content) {
      changes.push({ path: possiblePath, content });
    }
  }

  return changes;
}

function isValidFilePath(s: string): boolean {
  if (!s || s.length > 300) return false;
  if (s.includes('\n') || s.includes('\r') || s.includes('\0')) return false;
  // Normalize to forward slashes, then check for traversal
  const normalized = normalize(s).replace(/\\/g, '/');
  if (normalized.includes('../') || normalized.startsWith('/')) return false;
  // Allow only safe characters (no backslash — normalize already unified them)
  if (!/^[a-zA-Z0-9_\-./]+$/.test(normalized)) return false;
  return extname(normalized).length > 0;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
