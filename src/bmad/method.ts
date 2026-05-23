import { readFile, writeFile, mkdir, access, readdir } from 'fs/promises';
import { join } from 'path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { loadConfig, getApiKey } from '../core/config.js';
import { initClient } from '../core/api.js';
import type { Message } from '../core/api.js';
import { collectProjectContext, contextToSystemPrompt } from '../core/context.js';

interface Epic {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'done' | 'archived';
  stories: string[];
  createdAt: string;
}

interface Story {
  id: string;
  epicId: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  acceptanceCriteria: string[];
  tasks: string[];
  status: 'backlog' | 'in-progress' | 'review' | 'done';
  branch?: string;
  createdAt: string;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function readYaml<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf-8');
    return yaml.load(text) as T;
  } catch { return null; }
}

async function writeYaml(path: string, data: unknown): Promise<void> {
  await writeFile(path, yaml.dump(data, { indent: 2 }), 'utf-8');
}

function bmadDir(rootDir = process.cwd()): string {
  return join(rootDir, '.didev', 'bmad');
}

export async function runBmadInit(rootDir = process.cwd()): Promise<void> {
  logger.banner('BMad Method', 'Behavior-Motivated Agile Development');

  await mkdir(join(bmadDir(rootDir), 'epics'), { recursive: true });
  await mkdir(join(bmadDir(rootDir), 'stories'), { recursive: true });
  await mkdir(join(bmadDir(rootDir), 'architecture'), { recursive: true });
  await mkdir(join(bmadDir(rootDir), 'templates'), { recursive: true });

  const indexPath = join(bmadDir(rootDir), 'index.yaml');
  if (!await exists(indexPath)) {
    await writeYaml(indexPath, {
      project: '',
      epics: [],
      currentStory: null,
      createdAt: new Date().toISOString(),
    });
  }

  logger.success('BMad initialized in .didev/bmad/');
  logger.dim('Next: didev bmad epic — create your first epic');
}

export async function runBmadEpic(rootDir = process.cwd()): Promise<void> {
  const config = await loadConfig(rootDir);
  const apiKey = await getApiKey(config);

  if (!apiKey) { logger.error('API key not set'); return; }

  const { title, description } = await inquirer.prompt([
    { type: 'input', name: 'title', message: 'Epic title:', validate: (v: string) => v.length > 3 },
    { type: 'input', name: 'description', message: 'Epic description:' },
  ]);

  const client = initClient({ apiKey, baseUrl: config.api.baseUrl, model: config.api.model });
  const projectCtx = await collectProjectContext(rootDir);

  const spinner = logger.spinner('Generating epic breakdown...').start();

  const response = await client.chat([
    {
      role: 'system',
      content: `You are a Product Manager using BMad Method. ${contextToSystemPrompt(projectCtx)}`,
    },
    {
      role: 'user',
      content: `Create a detailed epic breakdown for: "${title}"\n\nDescription: ${description}\n\nProvide:
1. Refined epic description
2. List of 3-7 user stories (title only)
3. Technical considerations
4. Definition of Done

Format as YAML.`,
    },
  ]);

  spinner.stop();

  const epicId = `EPIC-${String(Date.now()).slice(-4)}`;
  const epic: Epic = {
    id: epicId,
    title,
    description,
    status: 'active',
    stories: [],
    createdAt: new Date().toISOString(),
  };

  const epicPath = join(bmadDir(rootDir), 'epics', `${epicId}.yaml`);
  await mkdir(join(bmadDir(rootDir), 'epics'), { recursive: true });
  await writeYaml(epicPath, { ...epic, aiBreakdown: response.content });

  logger.success(`Epic created: ${epicId}`);
  logger.newline();
  console.log(response.content);
}

export async function runBmadStory(rootDir = process.cwd()): Promise<void> {
  const config = await loadConfig(rootDir);
  const apiKey = await getApiKey(config);
  if (!apiKey) { logger.error('API key not set'); return; }

  // List epics
  const epicsDir = join(bmadDir(rootDir), 'epics');
  let epicFiles: string[] = [];
  try {
    epicFiles = (await readdir(epicsDir)).filter(f => f.endsWith('.yaml'));
  } catch { /* empty */ }

  if (epicFiles.length === 0) {
    logger.warn('No epics found. Run: didev bmad epic');
    return;
  }

  const epics: Epic[] = [];
  for (const f of epicFiles) {
    const e = await readYaml<Epic>(join(epicsDir, f));
    if (e) epics.push(e);
  }

  const { epicId, storyTitle, asA, iWant, soThat } = await inquirer.prompt([
    {
      type: 'list',
      name: 'epicId',
      message: 'Select epic:',
      choices: epics.map(e => ({ name: `${e.id}: ${e.title}`, value: e.id })),
    },
    { type: 'input', name: 'storyTitle', message: 'Story title:' },
    { type: 'input', name: 'asA', message: 'As a:', default: 'user' },
    { type: 'input', name: 'iWant', message: 'I want:' },
    { type: 'input', name: 'soThat', message: 'So that:' },
  ]);

  const client = initClient({ apiKey, baseUrl: config.api.baseUrl, model: config.api.model });
  const projectCtx = await collectProjectContext(rootDir);

  const spinner = logger.spinner('Generating story details...').start();

  const response = await client.chat([
    {
      role: 'system',
      content: `You are a Product Manager using BMad Method. ${contextToSystemPrompt(projectCtx)}

Generate detailed acceptance criteria and BDD scenarios for a user story.`,
    },
    {
      role: 'user',
      content: `User Story: "${storyTitle}"
As a ${asA}, I want ${iWant}, so that ${soThat}.

Generate:
1. 5-8 detailed Acceptance Criteria (Given/When/Then format)
2. Technical tasks breakdown (dev tasks)
3. Test scenarios
4. Any edge cases to consider`,
    },
  ]);

  spinner.stop();

  const storyId = `STORY-${String(Date.now()).slice(-4)}`;
  const story: Story = {
    id: storyId,
    epicId,
    title: storyTitle,
    asA,
    iWant,
    soThat,
    acceptanceCriteria: [],
    tasks: [],
    status: 'backlog',
    createdAt: new Date().toISOString(),
  };

  await mkdir(join(bmadDir(rootDir), 'stories'), { recursive: true });
  await writeYaml(join(bmadDir(rootDir), 'stories', `${storyId}.yaml`), {
    ...story,
    aiDetails: response.content,
  });

  logger.success(`Story created: ${storyId}`);
  logger.newline();
  console.log(response.content);
  logger.newline();
  logger.dim(`Next: didev bmad implement --story ${storyId}`);
}

export async function runBmadImplement(
  storyId?: string,
  rootDir = process.cwd()
): Promise<void> {
  let story: Story | null = null;

  if (storyId) {
    story = await readYaml<Story>(join(bmadDir(rootDir), 'stories', `${storyId}.yaml`));
  } else {
    // Find first in-progress or backlog story
    const storiesDir = join(bmadDir(rootDir), 'stories');
    try {
      const files = await readdir(storiesDir);
      for (const f of files) {
        const s = await readYaml<Story>(join(storiesDir, f));
        if (s && (s.status === 'in-progress' || s.status === 'backlog')) {
          story = s;
          break;
        }
      }
    } catch { /* empty */ }
  }

  if (!story) {
    logger.warn('No story to implement. Create one with: didev bmad story');
    return;
  }

  logger.info(`Implementing: ${story.id} — ${story.title}`);

  const { runOrchestration } = await import('../agents/orchestrator.js');
  await runOrchestration({
    task: `[BMad Story ${story.id}] ${story.title}
As a ${story.asA}, I want ${story.iWant}, so that ${story.soThat}.`,
    mode: 'full',
    rootDir,
  });

  // Mark story as in-progress
  story.status = 'in-progress';
  await writeYaml(join(bmadDir(rootDir), 'stories', `${story.id}.yaml`), story);
}

export async function runBmadReview(rootDir = process.cwd()): Promise<void> {
  const { runReview } = await import('../cli/commands/review.js');
  await runReview({ all: false, pr: false, save: true });
}
