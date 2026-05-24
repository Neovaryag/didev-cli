import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { loadConfig, getApiKey } from '../../core/config.js';
import { initClient } from '../../core/api.js';
import { collectProjectContext } from '../../core/context.js';
import { glob } from 'glob';
import yaml from 'js-yaml';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const IGNORE_PATTERNS = ['node_modules/**', 'dist/**', 'build/**', '.git/**', '*.lock', '*.min.js', '*.min.css', '*.map', 'coverage/**', '.turbo/**'];

// Key entry-point filenames to prioritize
const ENTRY_CANDIDATES = [
  'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
  'server.ts', 'server.js', 'cli.ts', 'cli.js',
  'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
  'src/app.ts', 'src/app.js', 'src/server.ts', 'src/server.js',
];

async function collectKeyFiles(rootDir: string): Promise<{ path: string; content: string }[]> {
  const result: { path: string; content: string }[] = [];
  let totalChars = 0;
  const maxChars = 80_000;

  const tryAdd = async (relPath: string) => {
    if (totalChars >= maxChars) return;
    try {
      const content = await readFile(join(rootDir, relPath), 'utf-8');
      const trimmed = content.slice(0, 6000);
      result.push({ path: relPath, content: trimmed });
      totalChars += trimmed.length;
    } catch { /* skip */ }
  };

  // README
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    if (await exists(join(rootDir, name))) { await tryAdd(name); break; }
  }

  // package.json / go.mod / Cargo.toml / pyproject.toml
  for (const cfg of ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'tsconfig.json']) {
    if (await exists(join(rootDir, cfg))) await tryAdd(cfg);
  }

  // Entry points
  for (const ep of ENTRY_CANDIDATES) {
    if (await exists(join(rootDir, ep))) await tryAdd(ep);
  }

  // Source files
  if (totalChars < maxChars) {
    const sourceFiles = await glob('src/**/*.{ts,tsx,js,jsx,py,go,rs,java}', {
      cwd: rootDir,
      ignore: IGNORE_PATTERNS,
    });
    // Sort: shorter paths (higher-level) first
    sourceFiles.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const f of sourceFiles) {
      if (result.some(r => r.path === f)) continue;
      await tryAdd(f);
      if (totalChars >= maxChars) break;
    }
  }

  return result;
}

async function collectBmadContext(rootDir: string): Promise<string | null> {
  const bmadDir = join(rootDir, '.didev', 'bmad');
  if (!(await exists(bmadDir))) return null;

  const parts: string[] = [];

  // index.yaml — current story pointer
  try {
    const indexRaw = await readFile(join(bmadDir, 'index.yaml'), 'utf-8');
    const index = yaml.load(indexRaw) as Record<string, unknown>;
    if (index?.currentStory) {
      parts.push(`**Current Story:** ${index.currentStory}`);
    }
  } catch { /* no index yet */ }

  // Active epics
  const epicFiles = await glob('epics/*.yaml', { cwd: bmadDir }).catch(() => []);
  const activeEpics: string[] = [];
  for (const f of epicFiles) {
    try {
      const raw = await readFile(join(bmadDir, f), 'utf-8');
      const epic = yaml.load(raw) as Record<string, unknown>;
      if (epic?.status !== 'archived') {
        activeEpics.push(`- **${epic?.id}**: ${epic?.title} (${epic?.status})`);
      }
    } catch { /* skip */ }
  }
  if (activeEpics.length > 0) {
    parts.push(`**Active Epics:**\n${activeEpics.join('\n')}`);
  }

  // Stories (in-progress + backlog, max 10)
  const storyFiles = await glob('stories/*.yaml', { cwd: bmadDir }).catch(() => []);
  const relevantStories: string[] = [];
  for (const f of storyFiles.slice(0, 20)) {
    try {
      const raw = await readFile(join(bmadDir, f), 'utf-8');
      const story = yaml.load(raw) as Record<string, unknown>;
      if (story?.status === 'done') continue;
      const criteria = Array.isArray(story?.acceptanceCriteria)
        ? (story.acceptanceCriteria as string[]).slice(0, 3).map((c: string) => `  - ${c}`).join('\n')
        : '';
      relevantStories.push(
        `- **${story?.id}** [${story?.status}]: ${story?.title}\n${criteria}`
      );
    } catch { /* skip */ }
  }
  if (relevantStories.length > 0) {
    parts.push(`**Stories (active/backlog):**\n${relevantStories.join('\n')}`);
  }

  // Architecture docs
  const archFiles = await glob('architecture/*.{md,yaml,yml}', { cwd: bmadDir }).catch(() => []);
  for (const f of archFiles.slice(0, 5)) {
    try {
      const content = await readFile(join(bmadDir, f), 'utf-8');
      parts.push(`**Architecture doc (${f}):**\n${content.slice(0, 3000)}`);
    } catch { /* skip */ }
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

export async function generateContextDocument(rootDir: string, apiKey: string, model: string, baseUrl?: string): Promise<string> {
  const client = initClient({ apiKey, model, maxTokens: 8192, temperature: 0.2, baseUrl });
  const projectCtx = await collectProjectContext(rootDir);
  const [keyFiles, bmadContext] = await Promise.all([
    collectKeyFiles(rootDir),
    collectBmadContext(rootDir),
  ]);

  const filesSection = keyFiles
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const bmadSection = bmadContext
    ? `\n## BMad Project State\n${bmadContext}\n`
    : '';

  const bmadOutputSection = bmadContext
    ? `\n## Current Work (BMad)\n(Active epics, in-progress stories, and their acceptance criteria — derived from the BMad state above)\n`
    : '';

  const prompt = `You are a senior software architect. Analyze this project and produce a comprehensive **Project Knowledge Base** document in Markdown.

## Project Stats
- Name: ${projectCtx.name}
- Type: ${projectCtx.type}
- Language: ${projectCtx.language}
- Framework: ${projectCtx.framework}
- Files: ${projectCtx.stats.files}, Lines: ${projectCtx.stats.lines}
- Runtime deps: ${projectCtx.dependencies.runtime.slice(0, 20).join(', ')}
- Dev deps: ${projectCtx.dependencies.dev.slice(0, 15).join(', ')}
${bmadSection}
## Source Files
${filesSection}

---

Write a document with these exact sections (fill ALL of them based on the actual code above):

# Project Knowledge Base: ${projectCtx.name}

## Overview
(2-4 sentences: what this project does and who uses it)

## Architecture
(How the codebase is structured — key layers, patterns, data flow)

## Key Modules
(Table or list of important files/directories with a one-line purpose for each)

## Tech Stack
(Language, framework, key libraries and why they're used)

## Coding Conventions
(Naming patterns, file organization, error handling approach, anything a new dev must know)

## Development
(How to install, run, build, test — exact commands if visible)
${bmadOutputSection}
## Important Notes
(Gotchas, non-obvious constraints, things to be careful about)

Be specific and concrete — reference actual file names, function names, and patterns you see in the code. Do NOT write placeholder text.`;

  const { finalContent } = await client.runToolLoop(
    [
      { role: 'system', content: 'You produce precise technical documentation based on actual code. Write only the markdown document, no preamble.' },
      { role: 'user', content: prompt },
    ],
    [],
    async () => '',
    model,
    { temperature: 0.2 },
    1,
  );

  return finalContent;
}

export interface ContextOptions {
  model?: string;
  yes?: boolean;
}

export async function runContextUpdate(options: ContextOptions = {}): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);

  if (!apiKey) {
    logger.error('API ключ не установлен. Выполните: didev config set DEEPSEEK_API_KEY=sk-xxx');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const didevDir = join(rootDir, '.didev');

  if (!(await exists(didevDir))) {
    logger.error('didev не инициализирован. Выполните: didev init');
    process.exit(1);
  }

  const model = options.model ?? config.api.model;
  const spinner = logger.spinner('Анализирую проект и генерирую базу знаний...').start();

  try {
    const doc = await generateContextDocument(rootDir, apiKey, model, config.api.baseUrl);
    await writeFile(join(didevDir, 'context.md'), doc, 'utf-8');
    spinner.succeed('База знаний проекта создана: .didev/context.md');
    logger.newline();
    logger.dim('Теперь при каждом запуске didev chat / didev agent этот документ');
    logger.dim('автоматически загружается в контекст без повторного сканирования.');
  } catch (e) {
    spinner.fail('Ошибка генерации: ' + (e as Error).message);
    process.exit(1);
  }
}

export async function runContextShow(): Promise<void> {
  const rootDir = process.cwd();
  const docPath = join(rootDir, '.didev', 'context.md');

  if (!(await exists(docPath))) {
    logger.warn('База знаний не создана. Выполните: didev context update');
    return;
  }

  const content = await readFile(docPath, 'utf-8');
  logger.newline();
  console.log(content);
}
