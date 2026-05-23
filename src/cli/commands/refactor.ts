import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../../utils/logger.js';
import { loadConfig, getApiKey } from '../../core/config.js';
import { initClient } from '../../core/api.js';
import { collectProjectContext, contextToSystemPrompt } from '../../core/context.js';
import { readProjectFile, writeProjectFile, renderDiff } from '../../core/file-manager.js';
import { AGENT_TOOLS } from '../../agents/base-agent.js';
import type { FileChange } from '../../agents/base-agent.js';
import { getChangedFiles } from '../../utils/git.js';
import { glob } from 'glob';

export interface RefactorOptions {
  auto?: boolean;
  dryRun?: boolean;
  file?: string;
  model?: string;
}

export async function runRefactor(
  instruction: string | undefined,
  options: RefactorOptions = {}
): Promise<void> {
  const config = await loadConfig();
  const apiKey = await getApiKey(config);

  if (!apiKey) {
    logger.error('DEEPSEEK_API_KEY not set. Run: didev config set DEEPSEEK_API_KEY=sk-xxx');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const client = initClient({
    apiKey,
    baseUrl: config.api.baseUrl,
    model: options.model ?? config.api.model,
    maxTokens: config.api.maxTokens,
    temperature: 0.2,
  });

  const model = options.model ?? config.api.model;
  const projectCtx = await collectProjectContext(rootDir);

  logger.banner('didev refactor', 'AI-powered refactoring');

  let userInstruction = instruction ?? '';

  if (!userInstruction && !options.auto) {
    const { inst } = await inquirer.prompt([{
      type: 'input',
      name: 'inst',
      message: 'Describe what to refactor:',
    }]);
    userInstruction = inst;
  }

  // Determine target files
  let targetFiles: string[] = [];
  if (options.file) {
    targetFiles = [options.file];
  } else if (options.auto) {
    targetFiles = await getChangedFiles(rootDir);
    if (targetFiles.length === 0) {
      targetFiles = await glob('src/**/*.{ts,tsx,js,jsx}', {
        cwd: rootDir,
        ignore: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', 'node_modules/**'],
      });
    }
  }

  const systemPrompt = `You are an expert ${projectCtx.language} refactoring specialist.

${contextToSystemPrompt(projectCtx)}

${options.auto ? `Automatically identify and fix refactoring opportunities:
- Code duplication (DRY violations)
- Large functions that should be split
- Poor naming
- Complex conditionals that can be simplified
- Missing TypeScript types
- Outdated patterns` : `Refactor according to the instruction: "${userInstruction}"`}

${options.dryRun ? `DRY RUN MODE: Describe the changes you WOULD make, but do NOT use write_file.` :
  `Use write_file to apply the refactoring. Read the file first, then write the complete refactored version.`}

For each refactoring:
1. Explain WHAT you're changing and WHY
2. Show the key before/after differences
3. Apply the change via write_file (unless dry-run)`;

  const fileContextParts: string[] = [];
  for (const f of targetFiles.slice(0, 30)) {
    try {
      const content = await readProjectFile(f, rootDir);
      fileContextParts.push(`## ${f}\n\`\`\`\n${content.slice(0, 200_000)}\n\`\`\``);
    } catch { /* skip */ }
  }

  const userMsg = fileContextParts.length > 0
    ? `Files to refactor:\n${fileContextParts.join('\n\n')}\n\n${userInstruction || 'Auto-refactor these files.'}`
    : userInstruction || 'Analyze the project and suggest refactoring improvements.';

  const spinner = logger.spinner({ text: chalk.gray('Analyzing and refactoring...'), color: 'cyan' }).start();

  const pendingWrites = new Map<string, string>();
  const fileChanges: FileChange[] = [];

  const { finalContent } = await client.runToolLoop(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ],
    AGENT_TOOLS,
    async (name, args) => {
      if (name === 'write_file') {
        const path = String(args['path']);
        const content = String(args['content']);
        if (options.dryRun) {
          pendingWrites.set(path, content);
          return `[DRY RUN] Would write: ${path}`;
        }
        await writeProjectFile(path, content, rootDir);
        fileChanges.push({ path, content });
        return `Refactored: ${path}`;
      }
      if (name === 'read_file') {
        try { return await readProjectFile(String(args['path']), rootDir); }
        catch (e) { return `Error: ${(e as Error).message}`; }
      }
      if (name === 'list_files') {
        try {
          const { glob } = await import('glob');
          const files = await glob(String(args['pattern'] ?? 'src/**/*'), {
            cwd: rootDir,
            ignore: ['node_modules/**', 'dist/**'],
          });
          return files.slice(0, 50).join('\n');
        } catch (e) { return `Error: ${(e as Error).message}`; }
      }
      return 'Tool not available';
    },
    model,
    { temperature: 0.2 }
  );

  spinner.stop();

  logger.newline();
  console.log(finalContent);
  logger.newline();

  if (options.dryRun && pendingWrites.size > 0) {
    logger.info(`Dry run complete. ${pendingWrites.size} file(s) would be modified.`);
    const { applyNow } = await inquirer.prompt([{
      type: 'confirm',
      name: 'applyNow',
      message: 'Apply these changes now?',
      default: false,
    }]);

    if (applyNow) {
      for (const [path, content] of pendingWrites) {
        const original = await readProjectFile(path, rootDir).catch(() => '');
        logger.newline();
        logger.bold(`File: ${path}`);
        console.log(renderDiff(path, original, content));
      }

      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Confirm all changes?',
        default: true,
      }]);

      if (confirm) {
        for (const [path, content] of pendingWrites) {
          await writeProjectFile(path, content, rootDir);
          logger.success(`Refactored: ${path}`);
        }
      }
    }
  } else if (fileChanges.length > 0) {
    logger.success(`Refactored ${fileChanges.length} file(s):`);
    fileChanges.forEach(fc => logger.dim(`  ${fc.path}`));
  }
}
