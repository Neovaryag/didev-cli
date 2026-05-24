import PptxGenJS from 'pptxgenjs';

const pptx = new PptxGenJS();

// ── Theme ────────────────────────────────────────────────────────────────────
const DARK   = '0D1117';
const ACCENT = '58A6FF';   // blue
const GREEN  = '3FB950';
const DIM    = '8B949E';
const WHITE  = 'F0F6FC';
const CARD   = '161B22';
const BORDER = '30363D';

pptx.layout  = 'LAYOUT_WIDE'; // 13.33 × 7.5 in
pptx.author  = 'Симонов Михаил Сергеевич';
pptx.subject = 'didev — AI-Powered Development CLI';

// ── Helpers ──────────────────────────────────────────────────────────────────
function bg(slide) {
  slide.background = { color: DARK };
}

function title(slide, text, y = 0.35, size = 28) {
  slide.addText(text, {
    x: 0.5, y, w: 12.33, h: 0.55,
    fontSize: size, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
}

function subtitle(slide, text, y = 0.95) {
  slide.addText(text, {
    x: 0.5, y, w: 12.33, h: 0.35,
    fontSize: 13, color: DIM, fontFace: 'Segoe UI',
  });
}

function divider(slide, y = 0.88) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y, w: 12.33, h: 0.02,
    fill: { color: BORDER }, line: { color: BORDER },
  });
}

function badge(slide, text, x, y, color = ACCENT) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w: text.length * 0.11 + 0.3, h: 0.28,
    fill: { color: DARK }, line: { color: color, width: 1 },
    rectRadius: 0.04,
  });
  slide.addText(text, {
    x, y, w: text.length * 0.11 + 0.3, h: 0.28,
    fontSize: 9, color: color, fontFace: 'Consolas', align: 'center',
  });
}

function card(slide, x, y, w, h) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h,
    fill: { color: CARD }, line: { color: BORDER, width: 1 },
    rectRadius: 0.08,
  });
}

function bullet(slide, items, x, y, w, opts = {}) {
  const lines = items.map(([icon, text]) => ({
    text: `${icon}  ${text}`,
    options: { bullet: false },
  }));
  slide.addText(lines, {
    x, y, w, h: items.length * 0.38,
    fontSize: opts.size ?? 13,
    color: opts.color ?? WHITE,
    fontFace: 'Segoe UI',
    valign: 'top',
    paraSpaceAfter: 6,
    ...opts,
  });
}

function codeBlock(slide, code, x, y, w, h) {
  card(slide, x, y, w, h);
  slide.addText(code, {
    x: x + 0.15, y: y + 0.1, w: w - 0.3, h: h - 0.2,
    fontSize: 10, color: GREEN, fontFace: 'Consolas',
    valign: 'top',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 1 — Title
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);

  // big accent line
  s.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.08, h: 7.5,
    fill: { color: ACCENT }, line: { color: ACCENT },
  });

  s.addText('didev', {
    x: 0.55, y: 1.6, w: 8, h: 1.4,
    fontSize: 72, bold: true, color: ACCENT, fontFace: 'Segoe UI',
  });
  s.addText('AI-Powered Development CLI', {
    x: 0.55, y: 3.0, w: 10, h: 0.55,
    fontSize: 24, color: WHITE, fontFace: 'Segoe UI',
  });
  s.addText('Персональная команда AI-разработчиков прямо в вашем терминале', {
    x: 0.55, y: 3.6, w: 10, h: 0.4,
    fontSize: 14, color: DIM, fontFace: 'Segoe UI',
  });

  s.addText('Автор: Симонов Михаил Сергеевич', {
    x: 0.55, y: 6.6, w: 6, h: 0.3,
    fontSize: 11, color: DIM, fontFace: 'Segoe UI',
  });

  // badges
  badge(s, 'v1.3.3',            9.5, 6.55, GREEN);
  badge(s, 'DeepSeek API',      10.4, 6.55, ACCENT);
  badge(s, 'Node.js 18+',       11.4, 6.55, DIM);
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 2 — Problem / Why didev?
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Зачем didev?');
  divider(s);

  // Left — problem
  card(s, 0.4, 1.05, 5.9, 5.9);
  s.addText('Проблемы обычных AI-ассистентов', {
    x: 0.6, y: 1.15, w: 5.5, h: 0.4,
    fontSize: 13, bold: true, color: DIM, fontFace: 'Segoe UI',
  });
  bullet(s, [
    ['✗', 'Не читают ваши реальные файлы'],
    ['✗', 'Один общий промпт — нет специализации'],
    ['✗', 'Агенты не передают контекст друг другу'],
    ['✗', 'Нет интеграции с инструментами проекта'],
    ['✗', 'Дорого (OpenAI GPT-4o)'],
  ], 0.6, 1.65, 5.5, { color: '#E06C75', size: 13 });

  // Right — solution
  card(s, 6.6, 1.05, 6.3, 5.9);
  s.addText('didev решает это', {
    x: 6.8, y: 1.15, w: 5.9, h: 0.4,
    fontSize: 13, bold: true, color: GREEN, fontFace: 'Segoe UI',
  });
  bullet(s, [
    ['✓', 'Читает реальный код вашего проекта'],
    ['✓', 'Специализированные агенты по ролям'],
    ['✓', 'Каждый агент получает результат предыдущего'],
    ['✓', 'MCP: подключайте любые внешние инструменты'],
    ['✓', 'DeepSeek — в 10–20× дешевле GPT-4o'],
  ], 6.8, 1.65, 5.9, { color: GREEN, size: 13 });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 3 — Quick Start
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Быстрый старт');
  divider(s);

  codeBlock(s, [
    '# 1. Установить глобально',
    'npm install -g didev',
    '',
    '# 2. Перейти в проект',
    'cd my-project',
    '',
    '# 3. Инициализировать',
    'didev init',
    '',
    '# 4. Установить API-ключ DeepSeek',
    'didev config set DEEPSEEK_API_KEY=sk-xxxxxxxxxxxx',
    '',
    '# 5. Начать чат с кодовой базой',
    'didev',
  ].join('\n'), 0.5, 1.05, 6.6, 5.9);

  // right tips
  card(s, 7.35, 1.05, 5.65, 2.6);
  s.addText('Модели', {
    x: 7.55, y: 1.15, w: 5.2, h: 0.35,
    fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  bullet(s, [
    ['⚡', 'deepseek-v4-flash — 1M контекст, быстрый'],
    ['🧠', 'deepseek-v4-pro — thinking, сложные задачи'],
  ], 7.55, 1.55, 5.2, { size: 11 });

  card(s, 7.35, 3.85, 5.65, 3.1);
  s.addText('Где взять API-ключ', {
    x: 7.55, y: 3.95, w: 5.2, h: 0.35,
    fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  bullet(s, [
    ['1.', 'platform.deepseek.com → API Keys'],
    ['2.', 'Billing → пополнить от $5'],
    ['3.', 'v4-flash: $0.27/1M вх · $1.10/1M вых'],
  ], 7.55, 4.4, 5.2, { size: 11 });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 4 — Agent Pipeline
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Multi-Agent Pipeline');
  divider(s);

  const agents = [
    { name: 'Analyst',   icon: '🔍', desc: 'Анализирует\nтребования', x: 0.3 },
    { name: 'Architect', icon: '📐', desc: 'Проектирует\nархитектуру', x: 2.9 },
    { name: 'Developer', icon: '💻', desc: 'Пишет\nкод',            x: 5.5 },
    { name: 'Reviewer',  icon: '👁',  desc: 'Проверяет\nкачество',   x: 8.1 },
    { name: 'Tester',    icon: '🧪', desc: 'Пишет\nтесты',          x: 10.7 },
  ];

  agents.forEach(a => {
    card(s, a.x, 1.3, 2.35, 2.4);
    s.addText(a.icon, {
      x: a.x, y: 1.45, w: 2.35, h: 0.6,
      fontSize: 28, align: 'center',
    });
    s.addText(a.name, {
      x: a.x, y: 2.1, w: 2.35, h: 0.35,
      fontSize: 14, bold: true, color: WHITE, fontFace: 'Segoe UI', align: 'center',
    });
    s.addText(a.desc, {
      x: a.x, y: 2.5, w: 2.35, h: 0.55,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI', align: 'center',
    });
  });

  // arrows
  [1, 2, 3].forEach(i => {
    s.addShape(pptx.ShapeType.rightArrow, {
      x: 2.55 + (i - 1) * 2.6, y: 2.2, w: 0.45, h: 0.35,
      fill: { color: ACCENT }, line: { color: ACCENT },
    });
  });
  // parallel arrow to reviewer+tester
  s.addShape(pptx.ShapeType.rightArrow, {
    x: 8.1 - 0.3, y: 2.2, w: 0.45, h: 0.35,
    fill: { color: ACCENT }, line: { color: ACCENT },
  });

  s.addText('⚡ Reviewer + Tester запускаются параллельно', {
    x: 7.8, y: 3.85, w: 5.1, h: 0.3,
    fontSize: 11, color: GREEN, fontFace: 'Segoe UI', align: 'center',
  });

  // modes
  card(s, 0.3, 4.3, 13.1, 2.7);
  s.addText('Режимы оркестрации', {
    x: 0.5, y: 4.4, w: 12.7, h: 0.35,
    fontSize: 13, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });

  const modes = [
    ['full',           'Analyst → Architect → Developer → Reviewer ∥ Tester'],
    ['light',          'Analyst → Developer → Reviewer'],
    ['developer-only', 'Developer (без планирования — быстро)'],
  ];
  modes.forEach(([mode, desc], i) => {
    s.addText(mode, {
      x: 0.55, y: 4.85 + i * 0.52, w: 2.2, h: 0.38,
      fontSize: 11, color: ACCENT, fontFace: 'Consolas',
    });
    s.addText(desc, {
      x: 2.9, y: 4.85 + i * 0.52, w: 10, h: 0.38,
      fontSize: 11, color: WHITE, fontFace: 'Segoe UI',
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 5 — Agent Families
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Семейства агентов');
  divider(s);

  const families = [
    {
      name: 'Frontend', icon: '🎨', x: 0.3, color: '#61DAFB',
      agents: ['FrontendAnalyst — UX, компоненты', 'FrontendArchitect — стейт, архитектура', 'FrontendDeveloper — React / TypeScript', 'Reviewer — качество, доступность', 'Tester — RTL, Playwright'],
    },
    {
      name: 'Backend', icon: '⚙️', x: 4.7, color: GREEN,
      agents: ['BackendAnalyst — API, модели данных', 'BackendArchitect — сервисы, БД схема', 'BackendDeveloper — Node.js / Java / Python', 'SecurityAuditor — OWASP, auth', 'Reviewer + Tester'],
    },
    {
      name: 'Fullstack', icon: '🔗', x: 9.1, color: '#E6B55A',
      agents: ['Сквозной пайплайн', 'Frontend + Backend агенты', 'Единый контекст задачи', 'Координация через Orchestrator'],
    },
  ];

  families.forEach(f => {
    card(s, f.x, 1.05, 4.1, 6.1);
    s.addText(f.icon + '  ' + f.name, {
      x: f.x + 0.2, y: 1.2, w: 3.7, h: 0.4,
      fontSize: 14, bold: true, color: f.color, fontFace: 'Segoe UI',
    });
    f.agents.forEach((ag, i) => {
      s.addText('▸  ' + ag, {
        x: f.x + 0.25, y: 1.75 + i * 0.62, w: 3.6, h: 0.5,
        fontSize: 10.5, color: WHITE, fontFace: 'Segoe UI',
      });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 6 — Chat Mode
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Режим чата');
  divider(s);

  // left — tools
  card(s, 0.3, 1.05, 6.0, 4.0);
  s.addText('Инструменты AI в чате', {
    x: 0.5, y: 1.15, w: 5.6, h: 0.4,
    fontSize: 13, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  const tools = [
    ['read_file',    'Читает любой файл проекта'],
    ['write_file',   'Предлагает изменения (с подтверждением)'],
    ['list_files',   'Список файлов по glob-паттерну'],
    ['search_code',  'Полнотекстовый поиск по проекту'],
    ['git_diff',     'Показывает git diff'],
    ['run_command',  'Выполняет shell-команды в проекте'],
  ];
  tools.forEach(([name, desc], i) => {
    s.addText(name, {
      x: 0.5, y: 1.65 + i * 0.52, w: 2.3, h: 0.38,
      fontSize: 10, color: ACCENT, fontFace: 'Consolas',
    });
    s.addText(desc, {
      x: 2.85, y: 1.65 + i * 0.52, w: 3.3, h: 0.38,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI',
    });
  });

  // right — token counter
  card(s, 6.6, 1.05, 6.3, 1.7);
  s.addText('Счётчик токенов', {
    x: 6.8, y: 1.15, w: 5.9, h: 0.35,
    fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  s.addText('ctx [████░░░░░░░░░░░░░░░░] 12.3k/1.00M  +0.8k out  ⚡ cache 73%', {
    x: 6.8, y: 1.55, w: 5.9, h: 0.35,
    fontSize: 9, color: GREEN, fontFace: 'Consolas',
  });
  s.addText('Показывает заполненность контекста и % кэша DeepSeek', {
    x: 6.8, y: 1.92, w: 5.9, h: 0.3,
    fontSize: 9.5, color: DIM, fontFace: 'Segoe UI',
  });

  // right — file confirm
  card(s, 6.6, 2.9, 6.3, 2.15);
  s.addText('4 варианта подтверждения файлов', {
    x: 6.8, y: 3.0, w: 5.9, h: 0.35,
    fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  bullet(s, [
    ['Enter/y', '— применить все изменения'],
    ['d',       '— показать diff, затем применить'],
    ['n',       '— отклонить + ввести правки'],
    ['a',       '— авто-режим до конца сессии'],
  ], 6.8, 3.45, 5.9, { size: 10.5, color: WHITE });

  // bottom — run_command highlight
  card(s, 0.3, 5.2, 12.6, 1.65);
  s.addText('🆕  run_command — выполнение команд без написания скриптов во /tmp/', {
    x: 0.5, y: 5.3, w: 12.2, h: 0.35,
    fontSize: 12, bold: true, color: GREEN, fontFace: 'Segoe UI',
  });
  s.addText('"проверь компиляцию проекта"  →  run_command("npm run build")  |  run_command("mvn compile")  |  run_command("./gradlew build")', {
    x: 0.5, y: 5.7, w: 12.2, h: 0.35,
    fontSize: 10, color: DIM, fontFace: 'Consolas',
  });
  s.addText('Работает для любого стека: Node.js, Java (Maven/Gradle), Angular, Python', {
    x: 0.5, y: 6.1, w: 12.2, h: 0.3,
    fontSize: 10, color: WHITE, fontFace: 'Segoe UI',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 7 — MCP Integration
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'MCP — Model Context Protocol');
  divider(s);

  s.addText('Подключайте любые внешние инструменты — они становятся доступны агентам и чату', {
    x: 0.5, y: 0.95, w: 12.3, h: 0.35,
    fontSize: 12, color: DIM, fontFace: 'Segoe UI',
  });

  codeBlock(s, [
    '# Из npm',
    'didev mcp add @modelcontextprotocol/server-github',
    '',
    '# Из Git (клонирует, собирает, настраивает автоматически)',
    'didev mcp add https://github.com/Neovaryag/mcp-pgs-tool.git',
    '',
    '# Список подключённых серверов',
    'didev mcp list',
  ].join('\n'), 0.3, 1.45, 6.3, 3.0);

  // servers table
  card(s, 6.8, 1.45, 6.1, 3.0);
  s.addText('Популярные серверы', {
    x: 7.0, y: 1.55, w: 5.7, h: 0.35,
    fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  const servers = [
    ['GitHub',       'Issues, PRs, code search'],
    ['PostgreSQL',   'Прямые SQL-запросы'],
    ['Java CVE',     'Сканер уязвимостей зависимостей'],
    ['Filesystem',   'Чтение файлов вне проекта'],
    ['Brave Search', 'Поиск в интернете'],
    ['Context7',     'Документация библиотек on-demand'],
  ];
  servers.forEach(([name, desc], i) => {
    s.addText(name, {
      x: 7.0, y: 2.0 + i * 0.37, w: 2.2, h: 0.32,
      fontSize: 10, color: ACCENT, fontFace: 'Segoe UI', bold: true,
    });
    s.addText(desc, {
      x: 9.3, y: 2.0 + i * 0.37, w: 3.4, h: 0.32,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI',
    });
  });

  // bottom — how it works
  const features = [
    ['🔌', 'Авто-старт при запуске didev'],
    ['🔒', 'Секреты в .didev/.env (gitignored)'],
    ['⚡', 'npx серверы: 90с таймаут на первый запуск'],
    ['🔗', 'Инструменты: serverName__toolName'],
  ];
  features.forEach((f, i) => {
    card(s, 0.3 + i * 3.28, 4.6, 3.1, 1.55);
    s.addText(f[0], {
      x: 0.3 + i * 3.28, y: 4.7, w: 3.1, h: 0.4,
      fontSize: 20, align: 'center',
    });
    s.addText(f[1], {
      x: 0.3 + i * 3.28, y: 5.15, w: 3.1, h: 0.7,
      fontSize: 10.5, color: WHITE, fontFace: 'Segoe UI', align: 'center',
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 8 — Build & Test Integration
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Build & Test Integration');
  divider(s);

  s.addText('didev автоматически определяет систему сборки и предлагает проверку после применения файлов', {
    x: 0.5, y: 0.95, w: 12.3, h: 0.35,
    fontSize: 12, color: DIM, fontFace: 'Segoe UI',
  });

  const stacks = [
    { name: 'Node.js / React', icon: '⚛', detect: 'package.json',   cmds: ['npm run build', 'npm test', 'npm run lint'],  color: '#61DAFB' },
    { name: 'Angular',         icon: '🅰', detect: 'angular.json',   cmds: ['ng build', 'ng test', 'ng e2e'],              color: '#DD0031' },
    { name: 'Maven',           icon: '☕', detect: 'pom.xml',        cmds: ['mvn compile', 'mvn test'],                    color: '#C04D3A' },
    { name: 'Gradle',          icon: '🐘', detect: 'build.gradle',   cmds: ['./gradlew build', './gradlew test'],           color: '#02303A' },
  ];

  stacks.forEach((st, i) => {
    const x = 0.3 + (i % 2) * 6.55;
    const y = 1.45 + Math.floor(i / 2) * 2.65;
    card(s, x, y, 6.25, 2.45);
    s.addText(st.icon + '  ' + st.name, {
      x: x + 0.2, y: y + 0.1, w: 5.8, h: 0.4,
      fontSize: 13, bold: true, color: st.color || WHITE, fontFace: 'Segoe UI',
    });
    s.addText('Детект: ' + st.detect, {
      x: x + 0.2, y: y + 0.55, w: 5.8, h: 0.3,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI',
    });
    st.cmds.forEach((cmd, ci) => {
      s.addText(cmd, {
        x: x + 0.2, y: y + 0.9 + ci * 0.42, w: 5.8, h: 0.35,
        fontSize: 10.5, color: GREEN, fontFace: 'Consolas',
      });
    });
  });

  // bottom note
  s.addText('После применения файлов → предложение запустить тесты или code review на изменённых файлах', {
    x: 0.5, y: 6.85, w: 12.3, h: 0.3,
    fontSize: 10.5, color: DIM, fontFace: 'Segoe UI', align: 'center',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 9 — Security & Reliability
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Безопасность и отказоустойчивость');
  divider(s);

  const security = [
    ['🔒', 'Path traversal защита', 'assertSafePath блокирует любые пути вне корня проекта (../../etc/passwd)'],
    ['🔑', 'Секреты не в коде',     'API-ключ в ~/.didev/config.yaml, MCP env в .didev/.env (gitignored)'],
    ['📦', 'Лимит файлов',          'Отказ записи при превышении 10MB'],
    ['🛡', 'OWASP аудит',           'SecurityAuditor агент — auth, SQL injection, XSS, IDOR'],
  ];

  const reliability = [
    ['⏱', 'Таймауты везде',        'HTTP 90s · run_command 60s · MCP 20–90s · git 15s'],
    ['🔄', 'Retry с backoff',       '5 попыток, экспоненциальный backoff + jitter'],
    ['🔁', 'Feedback loop',         'До 3 итераций Developer при отклонении изменений'],
    ['⚡', 'Параллельный review',   'Reviewer + Tester одновременно в full-режиме'],
    ['🔌', 'Idempotent MCP',        'connectAll безопасно вызывается несколько раз'],
  ];

  s.addText('Безопасность', {
    x: 0.5, y: 1.05, w: 6, h: 0.35,
    fontSize: 13, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  security.forEach((item, i) => {
    card(s, 0.3, 1.5 + i * 1.28, 6.2, 1.15);
    s.addText(item[0] + '  ' + item[1], {
      x: 0.5, y: 1.6 + i * 1.28, w: 5.8, h: 0.35,
      fontSize: 11, bold: true, color: WHITE, fontFace: 'Segoe UI',
    });
    s.addText(item[2], {
      x: 0.5, y: 1.98 + i * 1.28, w: 5.8, h: 0.35,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI',
    });
  });

  s.addText('Отказоустойчивость', {
    x: 6.95, y: 1.05, w: 6, h: 0.35,
    fontSize: 13, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });
  reliability.forEach((item, i) => {
    card(s, 6.75, 1.5 + i * 1.05, 6.2, 0.9);
    s.addText(item[0] + '  ' + item[1], {
      x: 6.95, y: 1.58 + i * 1.05, w: 5.8, h: 0.3,
      fontSize: 11, bold: true, color: WHITE, fontFace: 'Segoe UI',
    });
    s.addText(item[2], {
      x: 6.95, y: 1.88 + i * 1.05, w: 5.8, h: 0.28,
      fontSize: 9.5, color: DIM, fontFace: 'Segoe UI',
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 10 — Architecture
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Архитектура');
  divider(s);

  const modules = [
    { label: 'CLI Entry\nindex.ts', x: 5.8, y: 1.1, color: ACCENT },
    { label: 'DeepSeek\napi.ts',    x: 0.3, y: 2.5, color: GREEN },
    { label: 'MCP Manager\nmcp.ts', x: 3.2, y: 2.5, color: GREEN },
    { label: 'Config\nconfig.ts',   x: 6.1, y: 2.5, color: GREEN },
    { label: 'Context\ncontext.ts', x: 9.0, y: 2.5, color: GREEN },
    { label: 'file-manager\nassertSafePath', x: 11.5, y: 2.5, color: GREEN },
    { label: 'Orchestrator',        x: 0.3, y: 4.3, color: '#E6B55A' },
    { label: 'BaseAgent\n+run_command', x: 3.6, y: 4.3, color: '#E6B55A' },
    { label: 'Chat REPL\ntoken counter', x: 7.1, y: 4.3, color: '#E6B55A' },
    { label: 'build-runner\npost-apply',  x: 10.4, y: 4.3, color: '#E6B55A' },
  ];

  modules.forEach(m => {
    card(s, m.x, m.y, 2.5, 0.95);
    s.addText(m.label, {
      x: m.x + 0.1, y: m.y + 0.08, w: 2.3, h: 0.82,
      fontSize: 9.5, color: m.color, fontFace: 'Segoe UI', align: 'center', valign: 'middle',
    });
  });

  // arrows — CLI to core
  [0.3, 3.2, 6.1, 9.0, 11.5].forEach(x => {
    s.addShape(pptx.ShapeType.line, {
      x: 6.8, y: 2.05, w: x + 1.25 - 6.8, h: 0.45,
      line: { color: BORDER, width: 1, dashType: 'dash' },
    });
  });

  s.addText('TypeScript · ESM · Node 18+ · Commander.js · DeepSeek API · MCP SDK · pptxgenjs', {
    x: 0.5, y: 6.85, w: 12.3, h: 0.3,
    fontSize: 9.5, color: DIM, fontFace: 'Segoe UI', align: 'center',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 11 — Pricing
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);
  title(s, 'Стоимость использования');
  divider(s);

  card(s, 0.3, 1.1, 12.6, 2.5);
  s.addText('DeepSeek vs OpenAI', {
    x: 0.5, y: 1.2, w: 12.2, h: 0.35,
    fontSize: 13, bold: true, color: WHITE, fontFace: 'Segoe UI',
  });

  const pricing = [
    ['Модель',                 'Входящие (1M токенов)', 'Исходящие (1M токенов)', 'Контекст'],
    ['deepseek-v4-flash',      '$0.27',                  '$1.10',                  '1,000,000'],
    ['deepseek-v4-pro',        '$0.50',                  '$2.19',                  '64,000'],
    ['OpenAI GPT-4o (сравн.)', '$5.00',                  '$15.00',                 '128,000'],
  ];

  pricing.forEach((row, ri) => {
    row.forEach((cell, ci) => {
      const x = 0.5 + ci * 3.05;
      const y = 1.65 + ri * 0.43;
      s.addText(cell, {
        x, y, w: 3.0, h: 0.38,
        fontSize: ri === 0 ? 10 : (ci === 0 ? 11 : 12),
        bold: ri === 0,
        color: ri === 0 ? DIM : (ci === 0 ? (cell.includes('OpenAI') ? '#E06C75' : ACCENT) : (ri === 3 ? '#E06C75' : GREEN)),
        fontFace: ci === 0 ? 'Consolas' : 'Segoe UI',
      });
    });
  });

  s.addText('DeepSeek в 10–20× дешевле GPT-4o при сопоставимом качестве на задачах разработки', {
    x: 0.5, y: 3.75, w: 12.2, h: 0.35,
    fontSize: 13, bold: true, color: GREEN, fontFace: 'Segoe UI', align: 'center',
  });

  const tips = [
    ['⚡', 'Кэш промптов', 'DeepSeek кэширует повторяющийся контекст.\nСчётчик ⚡ cache N% показывает экономию в реальном времени.'],
    ['💡', 'v4-flash на каждый день', '1M токенов контекста — весь проект\nв одном окне. Быстрый и дешёвый.'],
    ['🧠', 'v4-pro для сложного', 'Thinking-модель для архитектурных\nрешений и нетривиальных задач.'],
  ];
  tips.forEach((t, i) => {
    card(s, 0.3 + i * 4.35, 4.2, 4.1, 2.7);
    s.addText(t[0], { x: 0.3 + i * 4.35, y: 4.3, w: 4.1, h: 0.5, fontSize: 22, align: 'center' });
    s.addText(t[1], { x: 0.5 + i * 4.35, y: 4.85, w: 3.7, h: 0.35, fontSize: 11, bold: true, color: WHITE, fontFace: 'Segoe UI', align: 'center' });
    s.addText(t[2], { x: 0.5 + i * 4.35, y: 5.25, w: 3.7, h: 0.9, fontSize: 10, color: DIM, fontFace: 'Segoe UI', align: 'center' });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SLIDE 12 — Summary
// ════════════════════════════════════════════════════════════════════════════
{
  const s = pptx.addSlide();
  bg(s);

  s.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.08, h: 7.5,
    fill: { color: GREEN }, line: { color: GREEN },
  });

  title(s, 'didev v1.3.3 — что умеет', 0.4, 22);
  divider(s, 0.95);

  const features = [
    ['💬', 'Интерактивный чат с проектом', 'Полный контекст кодовой базы, история сессий, счётчик токенов'],
    ['🤖', 'Multi-agent pipeline',          'Analyst → Architect → Developer → Reviewer ∥ Tester'],
    ['🔌', 'MCP интеграция',                'GitHub, PostgreSQL, Java CVE, Brave Search, Context7 и др.'],
    ['▶',  'run_command',                    'Запуск npm/mvn/gradle/tsc прямо из чата без скриптов'],
    ['✏️', 'Умное подтверждение файлов',    '4 варианта: Apply / Diff / Reject+правки / Auto-mode'],
    ['🔍', 'Детект сборки',                 'Node.js, Angular, Maven, Gradle — автоопределение'],
    ['🔒', 'Безопасность',                  'Path traversal защита, секреты в .env, OWASP аудит'],
    ['⚡', 'Надёжность',                    'Retry, таймауты, graceful shutdown, feedback loop'],
  ];

  features.forEach((f, i) => {
    const x = i < 4 ? 0.4 : 6.85;
    const y = 1.15 + (i % 4) * 1.42;
    card(s, x, y, 6.15, 1.25);
    s.addText(f[0] + '  ' + f[1], {
      x: x + 0.2, y: y + 0.1, w: 5.7, h: 0.38,
      fontSize: 12, bold: true, color: WHITE, fontFace: 'Segoe UI',
    });
    s.addText(f[2], {
      x: x + 0.2, y: y + 0.52, w: 5.7, h: 0.55,
      fontSize: 10, color: DIM, fontFace: 'Segoe UI',
    });
  });

  s.addText('npm install -g didev  ·  platform.deepseek.com  ·  npmjs.com/package/didev', {
    x: 0.5, y: 7.1, w: 12.3, h: 0.28,
    fontSize: 10, color: DIM, fontFace: 'Segoe UI', align: 'center',
  });
}

// ── Write file ────────────────────────────────────────────────────────────────
await pptx.writeFile({ fileName: 'didev-presentation.pptx' });
console.log('✓ didev-presentation.pptx создан');
