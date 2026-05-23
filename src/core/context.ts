import { readFile, readdir, stat, access } from 'fs/promises';
import { join, relative, extname, basename } from 'path';
import { glob } from 'glob';
import { countTokens } from '../utils/token-counter.js';
import { logger } from '../utils/logger.js';

export interface ProjectContext {
  name: string;
  type: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'library' | 'unknown';
  language: string;
  framework: string;
  rootDir: string;
  structure: {
    src?: string;
    tests?: string;
    docs?: string;
    config: string[];
  };
  dependencies: {
    runtime: string[];
    dev: string[];
  };
  stats: {
    files: number;
    lines: number;
  };
  recentFiles: string[];
  configFiles: string[];
}

export interface FileContext {
  path: string;
  content: string;
  tokens: number;
}

const IGNORE_PATTERNS = [
  'node_modules/**', 'dist/**', 'build/**', '.git/**',
  '*.lock', '*.min.js', '*.min.css', '*.map',
  '__pycache__/**', '*.pyc', '.next/**', '.nuxt/**',
  'coverage/**', '.turbo/**', 'out/**',
];

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.cs', '.rb', '.php',
  '.vue', '.svelte', '.html', '.css', '.scss', '.sass',
  '.json', '.yaml', '.yml', '.toml', '.env.example',
  '.md', '.sql', '.sh', '.bash',
]);

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function readJsonFile<T>(p: string): Promise<T | null> {
  try {
    const txt = await readFile(p, 'utf-8');
    return JSON.parse(txt) as T;
  } catch { return null; }
}

export async function collectProjectContext(rootDir = process.cwd()): Promise<ProjectContext> {
  const pkg = await readJsonFile<{
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(rootDir, 'package.json'));

  const name = pkg?.name ?? basename(rootDir);
  const runtimeDeps = Object.keys(pkg?.dependencies ?? {});
  const devDeps = Object.keys(pkg?.devDependencies ?? {});
  const allDeps = [...runtimeDeps, ...devDeps];

  // Detect language
  let language = 'javascript';
  if (await exists(join(rootDir, 'tsconfig.json')) || allDeps.includes('typescript')) {
    language = 'typescript';
  } else if (await exists(join(rootDir, 'go.mod'))) {
    language = 'go';
  } else if (await exists(join(rootDir, 'Cargo.toml'))) {
    language = 'rust';
  } else if (await exists(join(rootDir, 'requirements.txt')) || await exists(join(rootDir, 'pyproject.toml'))) {
    language = 'python';
  } else if (await exists(join(rootDir, 'pom.xml'))) {
    language = 'java';
  }

  // Detect framework
  let framework = 'none';
  if (allDeps.includes('next')) framework = 'nextjs';
  else if (allDeps.includes('react')) framework = 'react';
  else if (allDeps.includes('vue')) framework = 'vue';
  else if (allDeps.includes('svelte')) framework = 'svelte';
  else if (allDeps.includes('@angular/core')) framework = 'angular';
  else if (allDeps.includes('express')) framework = 'express';
  else if (allDeps.includes('fastify')) framework = 'fastify';
  else if (allDeps.includes('nestjs') || allDeps.includes('@nestjs/core')) framework = 'nestjs';
  else if (allDeps.includes('koa')) framework = 'koa';
  else if (allDeps.includes('hono')) framework = 'hono';

  // Detect project type
  const hasFrontend = ['react', 'nextjs', 'vue', 'svelte', 'angular'].includes(framework) ||
    allDeps.some(d => ['react-dom', 'vue', '@angular/core'].includes(d));
  const hasBackend = ['express', 'fastify', 'nestjs', 'koa', 'hono'].includes(framework) ||
    allDeps.some(d => ['express', 'fastify', 'koa', 'hono'].includes(d));

  let type: ProjectContext['type'] = 'unknown';
  if (hasFrontend && hasBackend) type = 'fullstack';
  else if (hasFrontend) type = 'frontend';
  else if (hasBackend) type = 'backend';
  else if (language !== 'javascript' && language !== 'typescript') type = 'backend';

  // Config files
  const configCandidates = ['package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
    'webpack.config.js', 'tailwind.config.ts', 'tailwind.config.js', '.eslintrc.json',
    '.eslintrc.js', 'jest.config.ts', 'jest.config.js', 'vitest.config.ts',
    'go.mod', 'Cargo.toml', 'requirements.txt', 'pyproject.toml', 'Makefile', 'Dockerfile'];
  const configFiles: string[] = [];
  for (const cf of configCandidates) {
    if (await exists(join(rootDir, cf))) configFiles.push(cf);
  }

  // Count files and lines
  let fileCount = 0;
  let lineCount = 0;
  try {
    const files = await glob('**/*.{ts,tsx,js,jsx,py,go,rs,java,vue,svelte}', {
      cwd: rootDir,
      ignore: IGNORE_PATTERNS,
    });
    fileCount = files.length;
    for (const f of files.slice(0, 200)) {
      try {
        const content = await readFile(join(rootDir, f), 'utf-8');
        lineCount += content.split('\n').length;
      } catch (e) {
        logger.debug(`context: skipping unreadable file ${f}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logger.debug(`context: glob failed: ${(e as Error).message}`);
  }

  // Recent/important files
  const recentFiles: string[] = [];
  const srcDir = join(rootDir, 'src');
  if (await exists(srcDir)) {
    try {
      const entries = await readdir(srcDir, { withFileTypes: true });
      for (const e of entries.slice(0, 10)) {
        if (e.isFile() && CODE_EXTENSIONS.has(extname(e.name))) {
          recentFiles.push(`src/${e.name}`);
        }
      }
    } catch (e) {
      logger.debug(`context: cannot read src dir: ${(e as Error).message}`);
    }
  }

  return {
    name,
    type,
    language,
    framework,
    rootDir,
    structure: {
      src: await exists(join(rootDir, 'src')) ? './src' : undefined,
      tests: (await exists(join(rootDir, '__tests__'))) ? './__tests__' :
             (await exists(join(rootDir, 'test'))) ? './test' :
             (await exists(join(rootDir, 'tests'))) ? './tests' : undefined,
      docs: await exists(join(rootDir, 'docs')) ? './docs' : undefined,
      config: configFiles,
    },
    dependencies: {
      runtime: runtimeDeps.slice(0, 30),
      dev: devDeps.slice(0, 20),
    },
    stats: { files: fileCount, lines: lineCount },
    recentFiles,
    configFiles,
  };
}

export function contextToSystemPrompt(ctx: ProjectContext): string {
  return `## Project Context
Name: ${ctx.name}
Type: ${ctx.type}
Language: ${ctx.language}
Framework: ${ctx.framework}
Stats: ${ctx.stats.files} files, ~${ctx.stats.lines} lines

## Dependencies
Runtime: ${ctx.dependencies.runtime.slice(0, 15).join(', ') || 'none'}
Dev: ${ctx.dependencies.dev.slice(0, 10).join(', ') || 'none'}

## Structure
${ctx.structure.src ? `Source: ${ctx.structure.src}` : ''}
${ctx.structure.tests ? `Tests: ${ctx.structure.tests}` : ''}
Config files: ${ctx.configFiles.join(', ')}`.trim();
}

export async function loadFilesForContext(
  paths: string[],
  rootDir: string,
  maxTokens = 6000
): Promise<FileContext[]> {
  const result: FileContext[] = [];
  let totalTokens = 0;

  for (const p of paths) {
    if (totalTokens >= maxTokens) break;
    try {
      const fullPath = join(rootDir, p);
      const content = await readFile(fullPath, 'utf-8');
      const tokens = countTokens(content);
      if (totalTokens + tokens > maxTokens) continue;
      result.push({ path: p, content, tokens });
      totalTokens += tokens;
    } catch (e) {
      logger.debug(`loadFilesForContext: skipping ${p}: ${(e as Error).message}`);
    }
  }

  return result;
}

export async function discoverRelevantFiles(
  query: string,
  rootDir: string,
  maxFiles = 20
): Promise<string[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  try {
    const allFiles = await glob('**/*.{ts,tsx,js,jsx,py,go,rs,vue,svelte,css,scss}', {
      cwd: rootDir,
      ignore: IGNORE_PATTERNS,
    });

    const scored = allFiles.map(f => {
      const lower = f.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score += 2;
      }
      // Prefer src/ files
      if (lower.startsWith('src/')) score += 1;
      return { path: f, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiles)
      .map(f => f.path);
  } catch (e) {
    logger.debug(`discoverRelevantFiles: glob failed: ${(e as Error).message}`);
    return [];
  }
}
