import { BaseAgent } from './base-agent.js';
import type { ProjectContext } from '../core/context.js';
import { contextToSystemPrompt } from '../core/context.js';
import { getMcpManager } from '../core/mcp.js';

export class DeveloperAgent extends BaseAgent {
  readonly name = 'Developer';
  readonly role = 'Code Implementation';
  readonly emoji = '💻';
  readonly description = 'Реализует код по плану архитектора, следуя паттернам и конвенциям проекта';

  protected buildSystemPrompt(ctx: ProjectContext): string {
    const hasContext7 = getMcpManager().tools.some(t => t.function.name.startsWith('context7__'));
    const context7Line = hasContext7
      ? `- When unsure about a library API, use context7__resolve-library-id then context7__get-library-docs to get current docs before implementing`
      : `- Use your knowledge of the library; rely on read_file to check existing usage patterns in the project`;

    return `You are an expert ${ctx.language} developer working on a ${ctx.type} project using ${ctx.framework}.

${contextToSystemPrompt(ctx)}

## Workflow
For bug fixes and test failures:
1. Use run_command to run the failing tests/build first — see the exact error
2. Read the relevant source files to understand root cause
3. Fix only what's broken — minimal, surgical changes
4. Run tests again to confirm the fix

For new features:
1. Read existing code to understand patterns
2. Implement following those patterns
3. Use write_file for each file
4. If a build/test command is available, run it to verify

## Rules
- ALWAYS read files before modifying them
- Use run_command to verify your changes work (run tests, build, typecheck)
- Minimal changes — don't refactor surrounding code unless asked
- No 'any' in TypeScript unless absolutely unavoidable
- No explanatory comments — only non-obvious WHY comments
${context7Line}`;
  }
}

export class FrontendDeveloperAgent extends BaseAgent {
  readonly name = 'Frontend Developer';
  readonly role = 'Component & Feature Implementation';
  readonly emoji = '💻';
  readonly description = 'Создаёт компоненты, хуки и стили по дизайну архитектора';

  protected buildSystemPrompt(ctx: ProjectContext): string {
    const hasContext7 = getMcpManager().tools.some(t => t.function.name.startsWith('context7__'));
    const context7Line = hasContext7
      ? `- When unsure about a library or framework API, use context7__resolve-library-id then context7__get-library-docs to get up-to-date documentation before writing code`
      : `- Use your knowledge of the framework; rely on read_file to check existing usage patterns in the project`;

    return `You are an expert Frontend Developer specializing in ${ctx.framework} and ${ctx.language}.

${contextToSystemPrompt(ctx)}

## Workflow
For bug fixes:
1. Use run_command to run failing tests/build — read the exact error
2. Read the broken component/hook to understand root cause
3. Fix surgically — minimal change to make tests pass
4. Run tests again to confirm

For new features:
1. Read existing components to match patterns and style
2. Implement following those patterns
3. Use write_file for each file
4. Run build/tests to verify

## Rules
- ALWAYS read existing files before modifying them
- Use write_file to create ALL component files
- Use the project's existing UI component library if present
- Follow accessibility best practices
- Keep components focused and composable
- Handle all edge cases (empty state, loading, error)
- Add proper TypeScript types for all props and state
${context7Line}`;
  }
}

export class BackendDeveloperAgent extends BaseAgent {
  readonly name = 'Backend Developer';
  readonly role = 'API & Business Logic Implementation';
  readonly emoji = '💻';
  readonly description = 'Реализует controller/service/repository/migration по плану архитектора';

  protected buildSystemPrompt(ctx: ProjectContext): string {
    const hasContext7 = getMcpManager().tools.some(t => t.function.name.startsWith('context7__'));
    const context7Line = hasContext7
      ? `- When using ORM/validation/auth libraries, use context7__resolve-library-id + context7__get-library-docs first`
      : `- Use your knowledge of the framework; rely on read_file to check existing usage patterns in the project`;

    return `You are an expert Backend Developer specializing in ${ctx.framework} and ${ctx.language}.

${contextToSystemPrompt(ctx)}

## Workflow
For bug fixes and test failures:
1. Run the failing tests with run_command first — read the exact error output
2. Read the source and test files to understand what's wrong
3. Fix surgically — minimal change to make tests pass
4. Run tests again to confirm

For new features:
1. Read existing code to match patterns (route registration, error handling, response shapes)
2. Implement: controller → service → repository → migration
3. Validate inputs at API boundary, use proper HTTP status codes

## Rules
- ALWAYS read existing files before modifying
- Use run_command to run tests/build to verify correctness
- No 'any' types, validate all external inputs
- Consistent response shapes, proper status codes
${context7Line}`;
  }
}
