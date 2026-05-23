import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { join } from 'path';
import type { Message } from './api.js';
import { logger } from '../utils/logger.js';

export interface Session {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  contextFiles: string[];
  metadata: Record<string, unknown>;
}

function sessionsDir(rootDir = process.cwd()): string {
  return join(rootDir, '.didev', 'sessions');
}

export async function saveSession(session: Session, rootDir = process.cwd()): Promise<void> {
  const dir = sessionsDir(rootDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${session.name}.json`);
  await writeFile(path, JSON.stringify(session, null, 2), 'utf-8');
}

export async function loadSession(name: string, rootDir = process.cwd()): Promise<Session | null> {
  try {
    const path = join(sessionsDir(rootDir), `${name}.json`);
    const text = await readFile(path, 'utf-8');
    return JSON.parse(text) as Session;
  } catch {
    return null;
  }
}

export async function listSessions(rootDir = process.cwd()): Promise<Session[]> {
  try {
    const dir = sessionsDir(rootDir);
    const files = await readdir(dir);
    const sessions: Session[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const text = await readFile(join(dir, f), 'utf-8');
        sessions.push(JSON.parse(text) as Session);
      } catch (e) {
        logger.debug(`session: skipping malformed session ${f}: ${(e as Error).message}`);
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch {
    return [];
  }
}

export async function deleteSession(name: string, rootDir = process.cwd()): Promise<void> {
  const path = join(sessionsDir(rootDir), `${name}.json`);
  await rm(path, { force: true });
}

export function createSession(name: string, metadata: Record<string, unknown> = {}): Session {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    contextFiles: [],
    metadata,
  };
}
