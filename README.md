# didev — AI-Powered Development CLI

> Персональная команда AI-разработчиков прямо в вашем терминале.  
> A specialized AI agent family for your codebase, powered by DeepSeek API.

**Автор:** Симонов Михаил Сергеевич

[![npm](https://img.shields.io/npm/v/didev)](https://www.npmjs.com/package/didev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![DeepSeek API](https://img.shields.io/badge/DeepSeek-API-cyan)](https://platform.deepseek.com)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-green)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/Node.js-18+-brightgreen)](https://nodejs.org)

---

## What is didev?

didev is a CLI tool that brings an entire team of specialized AI agents to your terminal. Unlike generic AI assistants, each agent in didev knows its role — frontend, backend, architecture, security, testing — and works in a coordinated pipeline to complete real development tasks.

**Key difference from ChatGPT / Copilot:** didev reads your actual project files, understands your codebase structure, and agents pass context to each other — each building on the previous agent's work.

---

## Models

| Model | Use case |
|-------|----------|
| `deepseek-v4-flash` *(default)* | Fast, 1M context window, 384K max output. Daily tasks. |
| `deepseek-v4-pro` | Thinking model — complex architecture decisions |

> **Note:** `deepseek-chat` and `deepseek-reasoner` aliases are deprecated as of 2026-07-24.

---

## Installation

```bash
npm install -g didev
```

Requirements: **Node.js 18+**

---

## Quick Start

```bash
# 1. Install globally
npm install -g didev

# 2. Go to your project
cd my-project

# 3. Initialize didev
didev init

# 4. Set your DeepSeek API key
didev config set DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx

# 5. Start chatting with your codebase
didev chat

# Or run the full AI agent pipeline on a task
didev agent "Add JWT authentication to Express API"
```

Get a DeepSeek API key at **[platform.deepseek.com](https://platform.deepseek.com)** → API Keys.

> Running `didev` with no arguments opens interactive chat immediately.

---

## Commands

### `didev init`
Initialize didev in the current project. Auto-detects language, framework, and project type.

```bash
didev init                 # interactive
didev init --frontend      # force frontend type
didev init --backend
didev init --fullstack
didev init -y              # non-interactive
```

Creates `.didev/` with config, context file, sessions dir, and BMad dirs.

---

### `didev config`

```bash
didev config set DEEPSEEK_API_KEY=sk-xxx
didev config set api.model=deepseek-v4-pro
didev config set api.temperature=0.5
didev config show
```

API key stored in `~/.didev/config.yaml` — never committed to the project.

---

### `didev chat`
Interactive REPL with full project context, token tracking, and shell execution.

```bash
didev chat
didev chat -m deepseek-v4-pro
didev chat -f src/api/routes.ts
```

**Slash commands:** `/menu` `/agent <task>` `/review` `/refactor` `/apply` `/files` `/add <path>` `/context` `/context update` `/save <name>` `/load <name>` `/sessions` `/config` `/clear` `/help` `/exit`

#### Token counter

Every response shows a real-time context usage bar:

```text
ctx [████░░░░░░░░░░░░░░░░] 12.3k/1.00M  +0.8k out  ⚡ cache 73%
```

- Bar fills as context grows toward the model's limit (1M for v4-flash, 64K for v4-pro)
- `⚡ cache N%` shows the DeepSeek prompt cache hit rate — high % = faster + cheaper responses

#### AI tools available in chat

| Tool | Description |
|------|-------------|
| `read_file` | Read any project file |
| `write_file` | Propose file changes (requires confirmation) |
| `list_files` | List files by glob pattern |
| `search_code` | Full-text search across project files |
| `git_diff` | Show git diff |
| `run_command` | Execute shell commands in the project directory |

The `run_command` tool lets the model run build/test commands directly:

```text
you › проверь запускается ли проект нет ли ошибок компиляции?
▶  Запускаю: npm run build
didev › Build successful — 0 errors, 2 warnings...
```

Works for any stack: `npm run build`, `mvn compile`, `./gradlew test`, `tsc --noEmit`, etc.

#### File write confirmation

When the AI proposes file changes, you get a 4-choice prompt:

```text
╭─────────────────────────────────────────╮
│ ✏️  Подготовлено 3 файл(а)              │
│   + src/auth/jwt.ts     новый           │
│   ~ src/app.ts          изменён         │
│   ~ src/config.ts       изменён         │
╰─────────────────────────────────────────╯
  [Enter/y] Применить  [d] Diff  [n] Отклонить  [a] Авто-режим
```

- **Enter/y** — apply all changes
- **d** — show colored diff first, then apply
- **n** — reject; you can then type corrections and the AI will try again
- **a** — auto-mode: apply all future writes in this session without asking

After applying, didev prompts whether to run tests or code review on the changed files.

---

### `didev agent`
Run the multi-agent pipeline on a development task.

```bash
didev agent "Add Stripe payment integration"
didev agent --type frontend "Build a responsive dashboard"
didev agent --mode light "Fix the login bug"
didev agent --mode developer-only "Add input validation"
didev agent --skip Tester "Quick feature"
```

**Orchestration modes:**
| Mode | Pipeline |
|------|----------|
| `full` | Analyst → Architect → Developer → [Reviewer ∥ Tester] |
| `light` | Analyst → Developer → Reviewer |
| `developer-only` | Developer only |

> В режиме `full` стадия Reviewer и Tester выполняется **параллельно** — это сокращает общее время пайплайна.

#### Agent feedback loop

When you reject an agent's file writes, you can provide corrections inline. The Developer agent re-runs with your feedback (up to 3 rounds) without losing the Analyst/Architect context from earlier pipeline stages.

---

### `didev review`

```bash
didev review               # review git diff
didev review --all         # all source files
didev review --file src/api.ts
didev review --pr          # vs main branch
```

---

### `didev refactor`

```bash
didev refactor "Extract service layer from controllers"
didev refactor --auto
didev refactor --dry-run "Rename userId to user_id"
```

---

### `didev mcp`
Manage MCP (Model Context Protocol) servers. Connected tools become available to all agents and chat.

```bash
# From GitHub / GitLab / Bitbucket (clones, installs, builds)
didev mcp add https://github.com/owner/repo.git
didev mcp add https://gitlab.com/owner/repo.git
didev mcp add https://bitbucket.org/owner/repo.git

# From npm
didev mcp add @modelcontextprotocol/server-filesystem

# Interactive wizard
didev mcp add

didev mcp list
didev mcp test
didev mcp remove my-server
```

**`didev mcp add <git-url>` flow:**
1. Clones repo to `~/.didev/mcp/<name>/`
2. Detects Node.js / Python
3. `npm install` + `npm run build` (or `pip install`)
4. Detects entry point automatically
5. Reads README → finds required env vars
6. Private repo? → prompts for GitHub/GitLab token or Bitbucket credentials
7. Credentials saved to `.didev/.env` (gitignored); config stores `${VAR}` references
8. Tests MCP connection, lists available tools
9. Saves to `.didev/config.yaml`

MCP servers auto-start when you run `didev` — no manual setup needed per session. npx-based servers get 90 seconds on first run to download packages.

---

### `didev bmad`
BMad Method — Behavior-Motivated Agile Development.

```bash
didev bmad init
didev bmad epic
didev bmad story
didev bmad implement
didev bmad review
```

---

## Build & Test Integration

didev automatically detects your project's build system and offers to run checks after applying changes:

| Project type | Detected by | Commands offered |
|---|---|---|
| Node.js / React | `package.json` | `npm run build`, `npm test`, `npm run lint` |
| Angular | `angular.json` | `ng build`, `ng test`, `ng e2e` |
| Maven | `pom.xml` | `mvn compile`, `mvn test` |
| Gradle | `build.gradle` | `./gradlew build`, `./gradlew test` |
| Frontend subdir | `src/package.json` | same as Node.js, in subdirectory |

Build errors are parsed and surfaced with file/line references.

---

## Agent Families

### Why specialized agents?
Each agent has a focused system prompt optimized for its role. A frontend agent doesn't need to reason about database internals. A security auditor doesn't write React components. Specialization produces significantly better output than one generic "do everything" agent.

Think of it like a craftsman's workshop: each wall holds tools for a specific trade. The carpenter's wall has chisels and planes; the electrician's wall has testers and crimpers. The master (Orchestrator) knows which specialist to engage and when.

### Frontend Family
| Agent | Specialty |
|-------|-----------|
| FrontendAnalyst | UX requirements, component design |
| FrontendArchitect | State management, component architecture |
| FrontendDeveloper | React, CSS, TypeScript implementation |
| Reviewer | Code quality, accessibility |
| Tester | RTL tests, Playwright |

### Backend Family
| Agent | Specialty |
|-------|-----------|
| BackendAnalyst | API design, data modeling |
| BackendArchitect | Service architecture, DB schema |
| BackendDeveloper | Node.js / Java / Python implementation |
| SecurityAuditor | OWASP, auth review |
| Reviewer | Error handling, code quality |
| Tester | Unit + integration tests |

### Fullstack Family
Analyst → Architect → Developer → Reviewer → Tester (cross-cutting)

---

## MCP Integration

MCP tools are namespaced as `serverName__toolName` to avoid conflicts:
```
github__create_issue
postgres__query
filesystem__read_file
```

MCP connections are managed by a singleton `McpManager` shared across chat and all agents in the same session. Calling `connectAll` multiple times is safe — already-connected servers are skipped automatically.

### Popular servers

| Server | Command |
|--------|---------|
| Filesystem | `didev mcp add @modelcontextprotocol/server-filesystem` |
| GitHub | `didev mcp add @modelcontextprotocol/server-github` |
| PostgreSQL | `didev mcp add https://github.com/Neovaryag/mcp-pgs-tool.git` |
| Java CVE scanner | `didev mcp add https://github.com/Neovaryag/java-vuln-remediation.git` |
| Brave Search | `didev mcp add @modelcontextprotocol/server-brave-search` |
| Memory | `didev mcp add @modelcontextprotocol/server-memory` |

---

## Project Structure

```
.didev/
  config.yaml      # project config (commit this, no secrets inside)
  context.md       # project context for AI (commit this)
  .env             # MCP credentials (gitignored)
  sessions/        # chat history (gitignored)
  bmad/            # epics, stories, architecture docs

~/.didev/
  config.yaml      # global config — API key lives here
  .env             # global git credentials for private MCP repos
  mcp/             # globally cloned MCP servers
```

---

## Security Model

| What | Where stored | Committed? |
|------|-------------|------------|
| DeepSeek API key | `~/.didev/config.yaml` or env var | Never |
| MCP env vars (DB URL, tokens) | `.didev/.env` | No (gitignored) |
| Git tokens for private MCP repos | `~/.didev/.env` | No |
| Project config | `.didev/config.yaml` with `${VAR}` placeholders | Yes |

**Path traversal protection:** all `read_file` / `write_file` calls resolve the path against the project root and reject any path that escapes it (e.g. `../../etc/passwd` → `Access denied`).

---

## Configuration Reference

```yaml
# .didev/config.yaml
api:
  provider: deepseek
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-v4-flash
  maxTokens: 32768
  temperature: 0.3
  baseUrl: https://api.deepseek.com/v1

context:
  maxFiles: 100
  maxTokens: 128000
  autoDiscover: true
  excludePatterns: [node_modules/**, dist/**, .git/**, "*.lock"]

agents:
  family: full        # full | light | developer-only
  orchestrate: true
  reviewRequired: true
  autoApply: false    # prompt before writing files

mcp:
  servers:
    - name: postgres
      command: node
      args: [/home/user/.didev/mcp/mcp-pgs-tool/dist/index.js]
      env:
        DATABASE_URL: ${DATABASE_URL}
```

---

## Getting DeepSeek API Key & Billing

1. Go to **[platform.deepseek.com](https://platform.deepseek.com)**
2. Sign up / log in
3. **API Keys** → Create new secret key → copy it
4. **Billing** → Top up balance (minimum ~$5)
5. Set the key:
   ```bash
   didev config set DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
   ```

**Pricing** (2026):
- `deepseek-v4-flash`: ~$0.27 / 1M input tokens · ~$1.10 / 1M output tokens
- Context window: **1,000,000 tokens**
- Max output per response: **384,000 tokens**

DeepSeek API is 10–20× cheaper than OpenAI GPT-4o for equivalent tasks.

---

## Architecture

```
src/
  index.ts              CLI entry (Commander.js) + graceful shutdown (SIGTERM/SIGINT)
  core/
    api.ts              DeepSeek client — chat, stream, tool loop, token usage tracking
    config.ts           Config load/save (global + local merge)
    context.ts          Project detection + file loading
    file-manager.ts     Read/write/diff — assertSafePath, 10MB limit
    mcp.ts              MCP manager — connect, call, tool namespacing, idempotent connectAll
    post-apply.ts       Post-apply build/test detection and prompts
    session.ts          Chat session persistence
  agents/
    base-agent.ts       BaseAgent — tools: read/write/list/search/git_diff/run_command + MCP
    analyst.ts          Analyst variants (frontend / backend / fullstack)
    architect.ts        Architect variants
    developer.ts        Developer variants
    reviewer.ts         Reviewer + SecurityAuditor
    tester.ts           Tester + PerformanceAuditor
    orchestrator.ts     Pipeline builder — parallel review phase, feedback loop
  cli/commands/
    init.ts             didev init
    config.ts           didev config
    chat.ts             didev chat — REPL, token counter, run_command, 4-choice confirm
    agent.ts            didev agent
    review.ts           didev review (read_file + write_file tools only)
    refactor.ts         didev refactor
    mcp.ts              didev mcp (add/list/test/remove)
    menu.ts             interactive menu — initializes MCP if not yet done
  bmad/method.ts        BMad workflow
  utils/
    logger.ts           Styled output (chalk, ora, boxen)
    git.ts              Git diff helpers — with timeout
    resilience.ts       withTimeout + retryWithBackoff
    build-runner.ts     Build script detection (npm/Maven/Gradle/Angular) + error parsing
    token-counter.ts    Token estimation utilities
```

---

## Отказоустойчивость

| Механизм | Где применяется | Детали |
| -------- | --------------- | ------- |
| **Таймауты** | API запросы, MCP, git, run_command | 90s stream, 60s run_command, 20–90s MCP connect (90s для npx) |
| **Retry с backoff** | DeepSeek API | 5 попыток, экспоненциальный backoff + jitter, только транзитные ошибки |
| **Graceful shutdown** | SIGTERM / SIGINT | Закрывает MCP серверы, 5s на очистку, затем force exit |
| **Параллельный review** | Orchestrator full mode | Reviewer + Tester запускаются одновременно |
| **Лимит файлов** | file-manager | Отказ записи если файл >10MB |
| **Безопасные пути** | file-manager | `assertSafePath` — блок path traversal (`../../`) |
| **Идемпотентный MCP** | McpManager | `connectAll` безопасно вызывается несколько раз — дублей нет |
| **Feedback loop** | Orchestrator | До 3 итераций Developer при отклонении изменений пользователем |
| **Логирование ошибок** | config, context, session | Все `catch` логируют через `logger.warn/debug` |

---

## License

MIT — Симонов Михаил Сергеевич, 2026
