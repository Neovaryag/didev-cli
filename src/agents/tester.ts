import { BaseAgent } from './base-agent.js';
import type { ProjectContext } from '../core/context.js';
import { contextToSystemPrompt } from '../core/context.js';

const DEV_AGENT_NAMES = ['Developer', 'Frontend Developer', 'Backend Developer'] as const;

export class TesterAgent extends BaseAgent {
  readonly name = 'Tester';
  readonly role = 'Test Writing';
  readonly emoji = '🧪';
  readonly description = 'Генерирует юнит и интеграционные тесты, покрывает критические пути и edge cases';

  protected get contextAgentNames() { return DEV_AGENT_NAMES; }
  override get preferFastModel() { return true; }

  protected buildSystemPrompt(ctx: ProjectContext): string {
    const testFramework = ctx.dependencies.dev.includes('vitest') ? 'Vitest'
      : ctx.dependencies.dev.includes('jest') ? 'Jest'
      : ctx.dependencies.dev.includes('mocha') ? 'Mocha'
      : 'the project\'s test framework';

    return `You are an expert Test Engineer writing ${testFramework} tests for a ${ctx.language} ${ctx.type} project.

${contextToSystemPrompt(ctx)}

Your responsibilities:
1. Write unit tests for all new functions and components
2. Write integration tests for API endpoints
3. Write component tests for UI components
4. Aim for >80% code coverage
5. Test happy paths AND error cases
6. Test edge cases and boundary conditions

Testing strategy:
- Unit tests: Pure functions, utilities, hooks
- Component tests: UI behavior, user interactions, states
- Integration tests: API routes, database queries

Rules:
- Use write_file to create test files alongside implementation files
- Mock external dependencies (API calls, databases)
- Test file naming: *.test.ts or *.spec.ts
- Use describe/it blocks for clear structure
- Add meaningful test descriptions
- Read the implementation files before writing tests

Write tests that actually VALIDATE the implementation, not just check it runs.`;
  }
}

export class PerformanceAuditorAgent extends BaseAgent {
  readonly name = 'Performance Auditor';
  readonly role = 'Performance Analysis';
  readonly emoji = '⚡';
  readonly description = 'Ищет узкие места, N+1 запросы, утечки памяти и возможности кэширования';

  protected get contextAgentNames() { return DEV_AGENT_NAMES; }
  override get preferFastModel() { return true; }

  protected buildSystemPrompt(ctx: ProjectContext): string {
    return `You are a Performance Engineer analyzing a ${ctx.type} ${ctx.framework} application.

${contextToSystemPrompt(ctx)}

Analysis areas:
- Bundle size and code splitting opportunities
- Re-render causes (React memo, useMemo, useCallback)
- Data fetching efficiency (N+1 queries, over-fetching)
- Memory leaks (event listeners, subscriptions)
- Database query optimization
- Caching opportunities
- Lazy loading candidates

Output:
- Performance issues found (severity: high/medium/low)
- Specific recommendations with code examples
- Apply critical optimizations via write_file`;
  }
}
