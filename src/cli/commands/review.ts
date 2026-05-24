import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { loadConfig, getApiKey } from '../../core/config.js';
import { initClient } from '../../core/api.js';
import type { Message, Tool } from '../../core/api.js';
import { collectProjectContext, contextToSystemPrompt, loadFilesForContext } from '../../core/context.js';
import { getChangedFiles, getDiff } from '../../utils/git.js';
import { readProjectFile } from '../../core/file-manager.js';
import type { FileChange } from '../../agents/base-agent.js';

// Only expose tools the review executor actually handles — don't advertise list_files / search_code
// to the model since they return "Tool not available in review mode", which wastes tokens.
const REVIEW_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read contents of a project file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Apply a fix to a project file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Complete corrected file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
];
import { writeProjectFile } from '../../core/file-manager.js';
import { glob } from 'glob';
import { readFile } from 'fs/promises';

export interface ReviewOptions {
  all?: boolean;
  file?: string;
  pr?: boolean;
  model?: string;
  save?: boolean;
}

export async function runReview(options: ReviewOptions = {}): Promise<void> {
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

  logger.banner('didev review', 'AI-powered code review');

  let filesToReview: string[] = [];
  let codeContext = '';

  if (options.file) {
    filesToReview = [options.file];
    logger.info(`Reviewing file: ${options.file}`);
  } else if (options.pr) {
    logger.info('Reviewing PR changes (vs main)...');
    const diff = await getDiff('main', rootDir);
    codeContext = `\n## Git Diff (vs main)\n\`\`\`diff\n${diff.slice(0, 400_000)}\n\`\`\``;
    filesToReview = await getChangedFiles(rootDir);
    logger.info(`Files in PR: ${filesToReview.join(', ')}`);
  } else if (options.all) {
    logger.info('Reviewing all source files...');
    filesToReview = await glob('src/**/*.{ts,tsx,js,jsx,py,go}', {
      cwd: rootDir,
      ignore: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts'],
    });
  } else {
    logger.info('Reviewing changed files...');
    filesToReview = await getChangedFiles(rootDir);
    if (filesToReview.length === 0) {
      logger.warn('No changed files found. Use --all to review all files, or --file <path>');
      return;
    }
    logger.info(`Changed files: ${filesToReview.join(', ')}`);
  }

  if (filesToReview.length === 0) {
    logger.warn('No files to review');
    return;
  }

  // Load file contents
  let fileContents = codeContext;
  for (const f of filesToReview.slice(0, 50)) {
    try {
      const content = await readProjectFile(f, rootDir);
      fileContents += `\n\n## File: ${f}\n\`\`\`\n${content.slice(0, 200_000)}\n\`\`\``;
    } catch { /* skip */ }
  }

  const systemPrompt = `You are a senior code reviewer with expertise in ${projectCtx.language} and ${projectCtx.framework}.

${contextToSystemPrompt(projectCtx)}

Perform a comprehensive code review covering:
1. **Code Quality**: Readability, naming conventions, DRY, SOLID principles
2. **Security**: Injection, XSS, authentication issues, sensitive data exposure
3. **Performance**: Unnecessary computations, memory leaks, N+1 queries
4. **Error Handling**: Missing error handling, uncaught exceptions
5. **Types & Safety**: TypeScript type correctness, unsafe operations
6. **Architecture**: Coupling, cohesion, separation of concerns
7. **Testing**: Missing test coverage areas

Format your review with:
- Overall score (0-10)
- Verdict: ✅ Ready / ⚠️ Minor Issues / ❌ Critical Issues
- Issues categorized by severity: CRITICAL / HIGH / MEDIUM / LOW
- Specific line references where possible
- Actionable improvement suggestions

Be specific and constructive. Reference actual code in your review.`;

  const spinner = logger.spinner({ text: chalk.gray('Analyzing code...'), color: 'cyan' }).start();

  const fileChanges: FileChange[] = [];

  const { finalContent } = await client.runToolLoop(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Please review the following code:\n${fileContents}` },
    ],
    REVIEW_TOOLS,
    async (name, args) => {
      if (name === 'write_file') {
        const path = String(args['path']);
        const content = String(args['content']);
        await writeProjectFile(path, content, rootDir);
        fileChanges.push({ path, content });
        return `Fixed: ${path}`;
      }
      if (name === 'read_file') {
        try { return await readProjectFile(String(args['path']), rootDir); }
        catch (e) { return `Error: ${(e as Error).message}`; }
      }
      return 'Tool not available in review mode';
    },
    model,
    { temperature: 0.2 }
  );

  spinner.stop();

  logger.newline();
  console.log(finalContent);
  logger.newline();

  if (fileChanges.length > 0) {
    logger.success(`Applied ${fileChanges.length} fix(es) during review`);
  }

  // Save report
  if (options.save !== false) {
    try {
      const reviewsDir = join(rootDir, '.didev', 'reviews');
      await mkdir(reviewsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = join(reviewsDir, `review-${timestamp}.md`);
      const report = `# Code Review Report\n**Date**: ${new Date().toLocaleString()}\n**Files**: ${filesToReview.join(', ')}\n\n${finalContent}`;
      await writeFile(reportPath, report, 'utf-8');
      logger.dim(`\nReport saved: .didev/reviews/review-${timestamp}.md`);
    } catch { /* non-critical */ }
  }
}
