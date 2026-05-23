import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import type { McpServerConfig } from './mcp.js';
import { logger } from '../utils/logger.js';

export type { McpServerConfig };

export interface DidevConfig {
  api: {
    provider: 'deepseek';
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature: number;
    baseUrl?: string;
  };
  context: {
    maxFiles: number;
    maxTokens: number;
    autoDiscover: boolean;
    excludePatterns: string[];
  };
  agents: {
    family: 'full' | 'light' | 'custom';
    orchestrate: boolean;
    reviewRequired: boolean;
    autoApply: boolean;
  };
  bmad: {
    enabled: boolean;
    templatesPath: string;
    linkIssues: boolean;
  };
  output: {
    style: 'fancy' | 'minimal' | 'json';
    color: boolean;
    saveSessions: boolean;
  };
  mcp: {
    servers: McpServerConfig[];
  };
}

const DEFAULT_CONFIG: DidevConfig = {
  api: {
    provider: 'deepseek',
    apiKey: '',
    model: 'deepseek-v4-flash',   // deepseek-chat alias, context: 1M, max output: 384K
    maxTokens: 32768,
    temperature: 0.3,
    baseUrl: 'https://api.deepseek.com/v1',
  },
  context: {
    maxFiles: 100,
    maxTokens: 128000,  // 1M context window — можно передавать гораздо больше
    autoDiscover: true,
    excludePatterns: ['node_modules/**', 'dist/**', '.git/**', '*.lock', '*.min.js'],
  },
  agents: {
    family: 'full',
    orchestrate: true,
    reviewRequired: true,
    autoApply: false,
  },
  bmad: {
    enabled: true,
    templatesPath: '.didev/bmad/templates',
    linkIssues: false,
  },
  output: {
    style: 'fancy',
    color: true,
    saveSessions: true,
  },
  mcp: {
    servers: [],
  },
};

function configPath(rootDir = process.cwd()): string {
  return join(rootDir, '.didev', 'config.yaml');
}

// Global config stored in user home dir
function globalConfigPath(): string {
  return join(homedir(), '.didev', 'config.yaml');
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function loadConfig(rootDir = process.cwd()): Promise<DidevConfig> {
  const localPath = configPath(rootDir);
  const globalPath = globalConfigPath();

  let config = structuredClone(DEFAULT_CONFIG);

  // Load global config first, then override with local
  for (const path of [globalPath, localPath]) {
    if (await exists(path)) {
      try {
        const text = await readFile(path, 'utf-8');
        const loaded = yaml.load(text) as Partial<DidevConfig>;
        config = deepMerge(config, loaded) as DidevConfig;
      } catch (e) {
        logger.warn(`Config parse error in ${path}: ${(e as Error).message}`);
      }
    }
  }

  // Environment variables override config file
  const envKey = process.env['DEEPSEEK_API_KEY'];
  if (envKey) config.api.apiKey = envKey;

  const envModel = process.env['DEEPSEEK_MODEL'];
  if (envModel) config.api.model = envModel;

  return config;
}

export async function saveConfig(config: DidevConfig, rootDir = process.cwd(), global = false): Promise<void> {
  const path = global ? globalConfigPath() : configPath(rootDir);
  await mkdir(join(path, '..'), { recursive: true });

  // Never save API key to file — use env vars
  const toSave = structuredClone(config);
  if (toSave.api.apiKey && !global) {
    toSave.api.apiKey = '${DEEPSEEK_API_KEY}';
  }

  const text = yaml.dump(toSave, { indent: 2, lineWidth: 100 });
  await writeFile(path, text, 'utf-8');
}

export async function setConfigValue(key: string, value: string, rootDir = process.cwd()): Promise<void> {
  const config = await loadConfig(rootDir);

  // Special handling for API key — save to global config
  if (key === 'DEEPSEEK_API_KEY' || key === 'api.apiKey') {
    const globalPath = globalConfigPath();
    await mkdir(join(globalPath, '..'), { recursive: true });
    let globalConfig = structuredClone(DEFAULT_CONFIG);
    if (await exists(globalPath)) {
      try {
        const text = await readFile(globalPath, 'utf-8');
        globalConfig = deepMerge(globalConfig, yaml.load(text) as Partial<DidevConfig>) as DidevConfig;
      } catch (e) {
        logger.warn(`Global config parse error: ${(e as Error).message}`);
      }
    }
    globalConfig.api.apiKey = value;
    const text = yaml.dump(globalConfig, { indent: 2 });
    await writeFile(globalPath, text, 'utf-8');
    return;
  }

  // Set nested key like "api.model" or "agents.autoApply"
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] === undefined) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const last = parts[parts.length - 1];

  // Type coercion — only convert to number if the entire string is numeric
  if (value === 'true') obj[last] = true;
  else if (value === 'false') obj[last] = false;
  else if (value !== '' && !isNaN(Number(value)) && String(Number(value)) === value) obj[last] = Number(value);
  else obj[last] = value;

  await saveConfig(config, rootDir);
}

export async function getApiKey(config: DidevConfig): Promise<string> {
  if (config.api.apiKey && config.api.apiKey !== '${DEEPSEEK_API_KEY}') {
    return config.api.apiKey;
  }
  return process.env['DEEPSEEK_API_KEY'] ?? '';
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  if (!source) return target;
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source as object)) {
    const sv = (source as Record<string, unknown>)[key];
    const tv = (target as Record<string, unknown>)[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
        tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv as Partial<typeof tv>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result as T;
}
