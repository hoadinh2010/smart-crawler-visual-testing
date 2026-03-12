# Generic Visual Testing Skill — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the monolithic `crawler-script.ts` (1,386 lines, MUI-specific) into generic, modular architecture supporting any UI framework.

**Architecture:** Extract code into 8 focused modules in `src/`. Replace MUI-hardcoded selectors with generic heuristics. Add AI-assisted fallback for login and navigation detection via exit-and-resume protocol with session persistence.

**Tech Stack:** TypeScript, Playwright, Claude Code skills (SKILL.md orchestration)

**Spec:** [docs/superpowers/specs/2026-03-12-generic-visual-testing-design.md](../specs/2026-03-12-generic-visual-testing-design.md)

---

## Chunk 1: Foundation — Types & Utils

### Task 1: Create `src/types.ts`

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create types file with all shared interfaces**

Extract all interfaces from `crawler-script.ts` (lines 7-106) into `src/types.ts`. Add new types for AI protocol and navigation detection.

```typescript
// src/types.ts
import type { Page, BrowserContext } from 'playwright';

// --- Config ---

export interface CrawlerConfig {
  baseUrl: string;
  auth: {
    loginPath: string;
    username: string;
    password: string;
    postLoginPath?: string;
    successUrlPattern?: string;
  };
  viewport: { width: number; height: number };
  screenshotDir: string;
  timeouts: {
    navigation: number;
    element: number;
    retry: number;
  };
  limits: {
    maxPages: number;
    maxDuration: number;
    maxElementsPerPage: number;
  };
  // Manual override for sidebar navigation — if present, skip heuristic + AI detection
  sidebar?: {
    iconSelector?: string;
    submenuContainerSelector?: string;
    submenuItemSelector?: string;
    submenuTitleSelector?: string;
  };
  // Cached AI detection results — auto-populated, skip AI on subsequent runs
  cached?: {
    loginSelectors?: LoginSelectors | null;
    navType?: NavType | null;
    navRegion?: NavRegion | null;
  };
}

// --- Navigation ---

export type NavType = 'sidebar-left' | 'sidebar-right' | 'top-navbar' | 'hamburger' | 'tab-based' | 'mixed';

export interface NavRegion {
  top: number;
  left: number;
  width: number;
  height: number | string;
}

export interface NavDetectionResult {
  navType: NavType;
  region: NavRegion;
  hasText: boolean;
  hasNesting: boolean;
  nestingType?: 'accordion' | 'submenu-drawer' | 'dropdown' | 'hover';
}

export interface LoginSelectors {
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
}

// --- Menu & Elements ---

export interface MenuItem {
  label: string;
  url: string | null;
  level: number;
  children: MenuItem[];
  selector: string;
  navType?: NavType;
}

export type ElementType =
  | 'navigation'
  | 'action-open'
  | 'action-danger'
  | 'action-submit'
  | 'tab'
  | 'table-row'
  | 'dropdown'
  | 'external';

export interface PageElement {
  selector: string;
  label: string;
  type: ElementType;
  action: 'click' | 'click+cancel' | 'click+close' | 'skip';
}

// --- Test Plan ---

export interface TestPlanPage {
  index: number;
  menuPath: string;
  url: string;
  source: 'menu' | 'table-row-detail';
  elements: PageElement[];
}

export interface TestPlan {
  generatedAt: string;
  baseUrl: string;
  totalPages: number;
  totalElements: number;
  estimatedDuration: string;
  pages: TestPlanPage[];
  skippedExternal: number;
  skippedSubmit: number;
}

// --- Execution ---

export interface ScreenshotEntry {
  index: number;
  filename: string;
  menuPath: string;
  elementLabel: string | null;
  elementType: ElementType | 'page';
  url: string;
}

export interface ExecutionResult {
  page: TestPlanPage;
  status: 'pass' | 'issues' | 'failed' | 'skipped';
  duration: number;
  elementsClicked: number;
  elementsFailed: number;
  screenshots: ScreenshotEntry[];
  errors: string[];
}

export interface ExecutionState {
  screenshotCounter: number;
}

// --- AI Protocol ---

export interface SessionState {
  cookies: any[];
  localStorage: Record<string, string>;
  currentUrl: string;
}

export interface AiRequest {
  type: 'login' | 'navigation';
  screenshot: string;
  prompt: string;
  context: Record<string, any>;
}

export type CrawlerOutput =
  | { status: 'needs_ai'; aiRequest: AiRequest; sessionState: SessionState }
  | { status: 'test_plan'; testPlan: TestPlan }
  | { status: 'execution_result'; results: ExecutionResult[]; totalScreenshots: number; logFile: string }
  | { status: 'error'; error: string };

// --- CLI Input ---

export interface CliInput {
  mode: 'discover' | 'execute';
  config: CrawlerConfig;
  testPlan?: TestPlan;
  // AI results from previous pass
  aiResult?: {
    type: 'login' | 'navigation';
    data: LoginSelectors | NavDetectionResult;
  };
  // Session state to restore from previous pass
  sessionState?: SessionState;
}

// --- Logger ---

export type LogLevel = 'info' | 'warn' | 'error';
export type LogAction =
  | 'navigate' | 'page_load' | 'screenshot' | 'click'
  | 'close' | 'back' | 'timeout' | 'retry' | 'failed'
  | 'skip' | 'login' | 'discovery' | 'limit';
```

- [ ] **Step 2: Verify types compile**

Run: `cd /Users/hoadinh/Sites/smart-crawler-visual-testing && npx tsx --eval "import './src/types.ts'; console.log('types OK')"`
Expected: `types OK`

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared types for modular crawler"
```

---

### Task 2: Create `src/utils.ts`

**Files:**
- Create: `src/utils.ts`

- [ ] **Step 1: Create utils with logger, screenshot helper, page ready detection**

Extract `CrawlerLogger` (lines 110-153), `toKebab` (lines 932-940), `takeScreenshot` (lines 942-972), `waitForPageReady` (lines 772-795), and formatting helpers from `crawler-script.ts`. Replace MUI selectors with generic ones.

```typescript
// src/utils.ts
import type { Page, BrowserContext } from 'playwright';
import { writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import type {
  LogLevel, LogAction, ElementType, ScreenshotEntry,
  ExecutionState, SessionState, PageElement
} from './types.js';

// --- Logger ---

export class CrawlerLogger {
  private logFile: string;

  constructor(screenshotDir: string) {
    this.logFile = join(screenshotDir, 'crawler.log');
    writeFileSync(this.logFile, '');
  }

  log(level: LogLevel, action: LogAction, details: Record<string, any>): void {
    const ts = new Date().toISOString();
    const time = ts.substring(11, 19);
    const jsonLine = JSON.stringify({ ts, level, action, ...details });
    appendFileSync(this.logFile, jsonLine + '\n');

    const icon = this.getIcon(action);
    const actionStr = action.toUpperCase().padEnd(12);
    const menuPath = details.menuPath || '';
    const extra = this.formatExtra(action, details);
    console.error(`[${time}] ${icon} ${actionStr} ${menuPath}${extra}`);
  }

  private getIcon(action: LogAction): string {
    const icons: Record<string, string> = {
      navigate: '📍', page_load: '✅', screenshot: '📸',
      click: '🔘', close: '❎', back: '↩️ ',
      timeout: '⚠️ ', retry: '🔄', failed: '❌',
      skip: '⏭️ ', login: '🔑', discovery: '🔍', limit: '🛑',
    };
    return icons[action] || '•';
  }

  private formatExtra(action: LogAction, d: Record<string, any>): string {
    if (d.url) return ` (${d.url})`;
    if (d.element) return ` → "${d.element}" [${d.type || ''}]`;
    if (d.duration) return ` (${(d.duration / 1000).toFixed(1)}s)`;
    if (d.error) return ` — ${d.error}`;
    if (d.filename) return ` ${d.filename}`;
    return '';
  }
}

// --- Page Ready Detection ---

export async function waitForPageReady(page: Page, timeout: number): Promise<void> {
  // Step 1: Wait for network to settle (per spec Section 6)
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {
    // networkidle may not fire on some SPAs — proceed anyway
  });

  // Step 2: Check for content presence
  const contentSelectors = [
    'main',
    '[role="main"]',
    '#app > *',
    '#root > *',
    '.content',
    '[class*="layout"]',
  ];

  const selectorFound = await Promise.any(
    contentSelectors.map((sel) =>
      page.waitForSelector(sel, { state: 'visible', timeout: 3000 }).then(() => true)
    )
  ).catch(() => false);

  if (!selectorFound) {
    // Page may use unconventional structure — proceed anyway
  }

  // Step 3: Stability delay for SPA hydration
  await page.waitForTimeout(500);
}

// --- Screenshot ---

export function toKebab(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

export async function takeScreenshot(
  page: Page,
  screenshotDir: string,
  menuPath: string,
  elementLabel: string | null,
  elementType: ElementType | 'page',
  url: string,
  logger: CrawlerLogger,
  state: ExecutionState
): Promise<ScreenshotEntry> {
  state.screenshotCounter++;
  const index = state.screenshotCounter;
  const menuKebab = toKebab(menuPath);
  const elementKebab = elementLabel ? `-${toKebab(elementLabel)}` : '';
  const typeStr = elementType === 'page' ? 'page' : elementType;
  const filename = `${String(index).padStart(3, '0')}-${menuKebab}${elementKebab}-${typeStr}.png`;
  const filepath = join(screenshotDir, filename);

  await page.screenshot({ path: filepath, fullPage: true });
  logger.log('info', 'screenshot', { menuPath, filename });

  return { index, filename, menuPath, elementLabel, elementType, url };
}

// --- Session Persistence ---

export async function saveSessionState(
  page: Page,
  context: BrowserContext
): Promise<SessionState> {
  const cookies = await context.cookies();
  const localStorage = await page.evaluate(() => {
    const data: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key) data[key] = window.localStorage.getItem(key) || '';
    }
    return data;
  });
  return { cookies, localStorage, currentUrl: page.url() };
}

export async function restoreSessionState(
  page: Page,
  context: BrowserContext,
  session: SessionState,
  baseUrl: string
): Promise<void> {
  if (session.cookies.length > 0) {
    await context.addCookies(session.cookies);
  }
  // Navigate to same origin first so localStorage is scoped correctly
  // (localStorage is origin-scoped — setting it on about:blank would be lost)
  if (Object.keys(session.localStorage).length > 0) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.evaluate((data) => {
      for (const [key, value] of Object.entries(data)) {
        window.localStorage.setItem(key, value);
      }
    }, session.localStorage);
  }
  await page.goto(session.currentUrl, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page, 10000);
}

// --- Test Plan Formatting ---

export function formatTestPlan(plan: import('./types.js').TestPlan): string {
  const lines: string[] = [
    `## Test Plan — ${new Date().toISOString().substring(0, 16)}`,
    '',
    '| # | Menu Path | URL | Elements | Actions |',
    '|---|-----------|-----|----------|---------|',
  ];

  for (const p of plan.pages) {
    const clickable = p.elements.filter((e) => e.action !== 'skip');
    const elementSummary = summarizeElements(p.elements);
    const actionSummary = summarizeActions(clickable);
    const prefix = p.source === 'table-row-detail' ? '  ↳' : String(p.index + 1);
    lines.push(`| ${prefix} | ${p.menuPath} | ${p.url} | ${elementSummary} | ${actionSummary} |`);
  }

  lines.push('');
  lines.push(`**Total: ${plan.totalPages} pages, ${plan.totalElements} elements**`);
  lines.push(`**Estimated time: ${plan.estimatedDuration}**`);
  lines.push(`**Skipped: ${plan.skippedExternal} external links, ${plan.skippedSubmit} submit buttons**`);

  return lines.join('\n');
}

function summarizeElements(elements: PageElement[]): string {
  const counts: Record<string, number> = {};
  for (const e of elements) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(', ');
}

function summarizeActions(elements: PageElement[]): string {
  const clicks = elements.filter((e) => e.action === 'click').length;
  const clickCancel = elements.filter((e) => e.action === 'click+cancel').length;
  const clickClose = elements.filter((e) => e.action === 'click+close').length;
  const parts: string[] = [];
  if (clicks) parts.push(`${clicks} click`);
  if (clickClose) parts.push(`${clickClose} click+close`);
  if (clickCancel) parts.push(`${clickCancel} click+cancel`);
  return parts.join(', ') || 'none';
}
```

- [ ] **Step 2: Verify utils compile**

Run: `npx tsx --eval "import './src/utils.ts'; console.log('utils OK')"`
Expected: `utils OK`

- [ ] **Step 3: Commit**

```bash
git add src/utils.ts
git commit -m "feat: add utils module (logger, screenshot, session, page ready)"
```

---

## Chunk 2: Login & AI Vision

### Task 3: Create `src/ai-vision.ts`

**Files:**
- Create: `src/ai-vision.ts`

- [ ] **Step 1: Create AI vision protocol module**

```typescript
// src/ai-vision.ts
import type { Page, BrowserContext } from 'playwright';
import type { AiRequest, SessionState, CrawlerOutput } from './types.js';
import { saveSessionState } from './utils.js';
import { join } from 'path';

/**
 * Build a needs_ai output for SKILL.md to dispatch an AI subagent.
 * Crawler exits after outputting this — SKILL.md handles AI dispatch and re-runs crawler.
 */
export async function requestAiAssistance(
  page: Page,
  context: BrowserContext,
  screenshotDir: string,
  type: 'login' | 'navigation',
  prompt: string,
  additionalContext: Record<string, any> = {}
): Promise<CrawlerOutput> {
  const screenshotPath = join(screenshotDir, `ai-${type}-detection.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const sessionState = await saveSessionState(page, context);

  return {
    status: 'needs_ai',
    aiRequest: {
      type,
      screenshot: screenshotPath,
      prompt,
      context: additionalContext,
    },
    sessionState,
  };
}

export const AI_PROMPTS = {
  login: `Analyze this login page screenshot. Identify:
1. The username/email input field
2. The password input field
3. The submit/login button

Return a JSON object with CSS selectors for each:
{
  "usernameSelector": "CSS selector for username field",
  "passwordSelector": "CSS selector for password field",
  "submitSelector": "CSS selector for submit button"
}

Use the most specific and reliable selectors (prefer id, name, aria-label over class names).`,

  navigation: `Analyze this page screenshot after login. Identify the navigation pattern:

1. Navigation type: sidebar-left, sidebar-right, top-navbar, hamburger, tab-based, or mixed
2. Approximate bounding box of the navigation area (in pixels from viewport)
3. Does navigation have text labels or is it icon-only?
4. Does it have nested levels (submenus, dropdowns, accordion)?
5. If nested, what type: accordion, submenu-drawer, dropdown, or hover?

Return a JSON object:
{
  "navType": "sidebar-left",
  "region": { "top": 0, "left": 0, "width": 240, "height": "100%" },
  "hasText": true,
  "hasNesting": true,
  "nestingType": "accordion"
}`,
};
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import './src/ai-vision.ts'; console.log('ai-vision OK')"`
Expected: `ai-vision OK`

- [ ] **Step 3: Commit**

```bash
git add src/ai-vision.ts
git commit -m "feat: add AI vision protocol module"
```

---

### Task 4: Create `src/login.ts`

**Files:**
- Create: `src/login.ts`

- [ ] **Step 1: Create login module with heuristic + AI fallback**

Extract login from `crawler-script.ts` (lines 157-194). Replace MUI selectors with generic heuristics. Add AI fallback.

```typescript
// src/login.ts
import type { Page, BrowserContext } from 'playwright';
import type { CrawlerConfig, LoginSelectors, CrawlerOutput } from './types.js';
import { CrawlerLogger, waitForPageReady } from './utils.js';
import { requestAiAssistance, AI_PROMPTS } from './ai-vision.js';

// Generic login selectors in priority order
const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[type="text"][name*="user"]',
  'input[name*="email"]',
  'input[name*="login"]',
  'input[type="text"][name*="name"]',
  'input[type="text"][autocomplete*="user"]',
  'input[type="text"]', // last resort — first text input
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
  'button:has-text("Đăng nhập")',
];

/**
 * Try heuristic login first. If heuristic fails to find fields, return needs_ai output.
 * If cached selectors are provided (from previous AI detection), use those directly.
 */
export async function login(
  page: Page,
  context: BrowserContext,
  config: CrawlerConfig,
  logger: CrawlerLogger,
  cachedSelectors?: LoginSelectors | null
): Promise<CrawlerOutput | 'success'> {
  const { baseUrl, auth, timeouts } = config;
  logger.log('info', 'login', { menuPath: 'Login', url: `${baseUrl}${auth.loginPath}` });

  await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: timeouts.navigation });
  await page.waitForLoadState('domcontentloaded');

  // Use cached AI selectors if available
  if (cachedSelectors) {
    try {
      return await loginWithSelectors(page, config, logger, cachedSelectors);
    } catch {
      // Cached selectors failed — clear cache and fall through to heuristic
      logger.log('warn', 'login', { menuPath: 'Login', error: 'Cached AI selectors failed, clearing cache and retrying heuristic...' });
      if (config.cached) config.cached.loginSelectors = null;
      // Reload login page for fresh attempt
      await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: timeouts.navigation });
      await page.waitForLoadState('domcontentloaded');
    }
  }

  // Try heuristic detection
  const detected = await detectLoginFields(page);
  if (detected) {
    return loginWithSelectors(page, config, logger, detected);
  }

  // Heuristic failed — request AI assistance
  logger.log('info', 'login', { menuPath: 'Login', element: 'Heuristic detection failed, requesting AI...' });
  return requestAiAssistance(
    page, context, config.screenshotDir,
    'login', AI_PROMPTS.login
  );
}

async function detectLoginFields(page: Page): Promise<LoginSelectors | null> {
  // Find username field
  let usernameSelector: string | null = null;
  for (const sel of USERNAME_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      usernameSelector = sel;
      break;
    }
  }

  // Find password field
  let passwordSelector: string | null = null;
  for (const sel of PASSWORD_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      passwordSelector = sel;
      break;
    }
  }

  // Find submit button
  let submitSelector: string | null = null;
  for (const sel of SUBMIT_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      submitSelector = sel;
      break;
    }
  }

  if (usernameSelector && passwordSelector && submitSelector) {
    return { usernameSelector, passwordSelector, submitSelector };
  }
  return null;
}

async function loginWithSelectors(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger,
  selectors: LoginSelectors
): Promise<'success'> {
  const { auth, timeouts } = config;

  await page.locator(selectors.usernameSelector).first().fill(auth.username);
  await page.locator(selectors.passwordSelector).first().fill(auth.password);
  await page.locator(selectors.submitSelector).first().click();

  // Wait for successful login
  const successPattern = auth.successUrlPattern || '**/admin**';
  try {
    await page.waitForURL(successPattern, { timeout: timeouts.navigation });
  } catch {
    // Check if we're still on login page (login failed)
    if (page.url().includes(auth.loginPath)) {
      throw new Error('Login failed. Check credentials or successUrlPattern in config.');
    }
    // If URL changed but doesn't match pattern, assume success
  }

  // Navigate to postLoginPath if configured
  if (auth.postLoginPath) {
    logger.log('info', 'login', { menuPath: 'Login', element: `Navigating to ${auth.postLoginPath}...` });
    await page.goto(`${config.baseUrl}${auth.postLoginPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeouts.navigation,
    });
    await waitForPageReady(page, timeouts.navigation);
  }

  logger.log('info', 'login', { menuPath: 'Login', element: 'Login successful' });
  return 'success';
}

/**
 * Quick check if session expired and re-login if needed.
 */
export async function checkAndRelogin(
  page: Page,
  context: BrowserContext,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<void> {
  const currentUrl = page.url();
  if (currentUrl.includes(config.auth.loginPath) || currentUrl.includes('/login')) {
    logger.log('warn', 'login', { menuPath: 'Session', error: 'Session expired, re-logging in...' });
    const result = await login(page, context, config, logger, config.cached?.loginSelectors);
    if (result !== 'success') {
      throw new Error('Session re-login failed and requires AI assistance. Restart the crawl.');
    }
  }
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import './src/login.ts'; console.log('login OK')"`
Expected: `login OK`

- [ ] **Step 3: Commit**

```bash
git add src/login.ts
git commit -m "feat: add login module with generic heuristic + AI fallback"
```

---

## Chunk 3: Navigation & Scanner

### Task 5: Create `src/navigator.ts`

**Files:**
- Create: `src/navigator.ts`

- [ ] **Step 1: Create navigator module**

Extract sidebar scanning from `crawler-script.ts` (lines 196-497). Replace MUI selectors. Add heuristic nav type detection + AI fallback. Support multiple nav types.

```typescript
// src/navigator.ts
import type { Page, BrowserContext } from 'playwright';
import type {
  CrawlerConfig, MenuItem, NavType, NavDetectionResult, NavRegion, CrawlerOutput
} from './types.js';
import { CrawlerLogger, waitForPageReady } from './utils.js';
import { requestAiAssistance, AI_PROMPTS } from './ai-vision.js';

/**
 * Main entry point: detect navigation type and scan menu items.
 * Returns menu items on success, or a needs_ai output if AI detection is needed.
 */
export async function discoverNavigation(
  page: Page,
  context: BrowserContext,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<MenuItem[] | CrawlerOutput> {
  logger.log('info', 'discovery', { menuPath: 'Navigation', element: 'Detecting navigation type...' });

  // Priority 1: Manual sidebar config override
  if (config.sidebar?.iconSelector) {
    logger.log('info', 'discovery', { menuPath: 'Navigation', element: 'Using manual sidebar config' });
    return scanIconSidebar(page, config.baseUrl, logger, config.sidebar);
  }

  // Priority 2: Cached AI results
  if (config.cached?.navType && config.cached?.navRegion) {
    logger.log('info', 'discovery', {
      menuPath: 'Navigation',
      element: `Using cached nav type: ${config.cached.navType}`,
    });
    const items = await scanMenuItems(page, config, logger, {
      navType: config.cached.navType,
      region: config.cached.navRegion,
      hasText: true,
      hasNesting: true,
    });
    if (items.length > 0) return items;
    // Cache was stale, fall through to fresh detection
    logger.log('warn', 'discovery', { menuPath: 'Navigation', error: 'Cached nav type found 0 items, re-detecting' });
  }

  // Priority 3: Heuristic navigation detection
  const detected = await detectNavTypeHeuristic(page, config, logger);
  if (detected) {
    const items = await scanMenuItems(page, config, logger, detected);
    if (items.length > 0) return items;
  }

  // Priority 4: AI-assisted detection
  logger.log('info', 'discovery', { menuPath: 'Navigation', element: 'Heuristic detection failed, requesting AI...' });
  return requestAiAssistance(
    page, context, config.screenshotDir,
    'navigation', AI_PROMPTS.navigation
  );
}

/**
 * Use AI detection result (from previous pass) to scan menu items.
 * Validates AI response and returns empty array + logs error if invalid.
 */
export async function discoverNavigationWithAiResult(
  page: Page,
  context: BrowserContext,
  config: CrawlerConfig,
  logger: CrawlerLogger,
  aiResult: NavDetectionResult
): Promise<MenuItem[] | CrawlerOutput> {
  // Validate AI response
  const validNavTypes: NavType[] = ['sidebar-left', 'sidebar-right', 'top-navbar', 'hamburger', 'tab-based', 'mixed'];
  if (!validNavTypes.includes(aiResult.navType)) {
    logger.log('error', 'discovery', {
      menuPath: 'Navigation',
      error: `Invalid navType from AI: "${aiResult.navType}". Retrying...`,
    });
    return requestAiAssistance(
      page, context, config.screenshotDir,
      'navigation',
      AI_PROMPTS.navigation + '\n\nPrevious response had invalid navType. Use one of: ' + validNavTypes.join(', ')
    );
  }

  if (aiResult.region) {
    const { width, height } = aiResult.region;
    const numHeight = typeof height === 'string' ? config.viewport.height : height;
    if (typeof width === 'number' && (width <= 0 || width > config.viewport.width)) {
      logger.log('warn', 'discovery', { menuPath: 'Navigation', error: `AI region width ${width} out of bounds, ignoring region` });
    }
  }

  logger.log('info', 'discovery', {
    menuPath: 'Navigation',
    element: `AI detected: ${aiResult.navType}`,
  });

  const items = await scanMenuItems(page, config, logger, aiResult);

  // If AI nav type found 0 items, retry with context (per spec Section 7)
  if (items.length === 0) {
    logger.log('warn', 'discovery', {
      menuPath: 'Navigation',
      error: `AI detected ${aiResult.navType} but found 0 menu items. Requesting re-analysis...`,
    });
    return requestAiAssistance(
      page, context, config.screenshotDir,
      'navigation',
      AI_PROMPTS.navigation + `\n\nPrevious detection said "${aiResult.navType}" but scanning found 0 menu items. Re-analyze carefully.`
    );
  }

  return items;
}

// --- Heuristic Nav Type Detection ---

async function detectNavTypeHeuristic(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<NavDetectionResult | null> {
  const viewportHeight = config.viewport.height;

  return page.evaluate((vpHeight: number) => {
    // Check for sidebar
    const sidebarCandidates = document.querySelectorAll('nav, aside, [role="navigation"]');
    for (const el of sidebarCandidates) {
      const rect = el.getBoundingClientRect();
      // Sidebar: narrow (<300px) and tall (>= 80% viewport)
      if (rect.width > 0 && rect.width < 300 && rect.height >= vpHeight * 0.8) {
        const isLeft = rect.left < 100;
        const isRight = rect.right > window.innerWidth - 100;
        const hasText = el.querySelectorAll('a, [role="menuitem"]').length > 0;
        const isIconOnly = rect.width < 100;
        const hasNesting = el.querySelectorAll('[aria-expanded], ul ul, [class*="submenu"], [class*="collapse"]').length > 0;

        if (isLeft || isRight) {
          return {
            navType: (isLeft ? 'sidebar-left' : 'sidebar-right') as any,
            region: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            hasText: hasText && !isIconOnly,
            hasNesting,
            nestingType: hasNesting ? 'accordion' as const : undefined,
          };
        }
      }
    }

    // Check for top navbar
    const headerCandidates = document.querySelectorAll('nav, header');
    for (const el of headerCandidates) {
      const rect = el.getBoundingClientRect();
      // Top navbar: wide, short, at top
      if (rect.top < 10 && rect.width > window.innerWidth * 0.5 && rect.height < 120) {
        const links = el.querySelectorAll('a[href], button');
        if (links.length >= 3) {
          return {
            navType: 'top-navbar' as any,
            region: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
            hasText: true,
            hasNesting: el.querySelectorAll('[aria-haspopup], [class*="dropdown"]').length > 0,
          };
        }
      }
    }

    // Check for hamburger
    const hamburgerCandidates = document.querySelectorAll(
      '[aria-label*="menu" i], button:has(svg), .hamburger, [class*="hamburger"]'
    );
    for (const el of hamburgerCandidates) {
      const rect = el.getBoundingClientRect();
      // Hamburger: small button in header area, no visible nav links elsewhere
      if (rect.top < 100 && rect.width < 80 && rect.height < 80) {
        return {
          navType: 'hamburger' as any,
          region: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          hasText: false,
          hasNesting: true,
          nestingType: 'submenu-drawer' as const,
        };
      }
    }

    return null;
  }, viewportHeight);
}

// --- Menu Item Scanning ---

async function scanMenuItems(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger,
  navInfo: NavDetectionResult
): Promise<MenuItem[]> {
  switch (navInfo.navType) {
    case 'sidebar-left':
    case 'sidebar-right':
      return scanSidebarMenuItems(page, config.baseUrl, logger, navInfo);
    case 'top-navbar':
      return scanTopNavbarItems(page, config.baseUrl, logger);
    case 'hamburger':
      return scanHamburgerItems(page, config.baseUrl, logger);
    case 'tab-based':
      return scanTabNavItems(page, logger);
    case 'mixed':
      // Try sidebar first, then top navbar, merge results
      const sidebarItems = await scanSidebarMenuItems(page, config.baseUrl, logger, navInfo);
      const topItems = await scanTopNavbarItems(page, config.baseUrl, logger);
      return dedupeMenuItems([...sidebarItems, ...topItems]);
    default:
      return [];
  }
}

// --- Sidebar Scanning ---

async function scanSidebarMenuItems(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger,
  navInfo: NavDetectionResult
): Promise<MenuItem[]> {
  // First check if sidebar has standard <a> links
  const standardItems = await scanStandardNavLinks(page, baseUrl, logger);
  if (standardItems.length > 0) return standardItems;

  // If no standard links, try icon sidebar approach
  return scanIconSidebar(page, baseUrl, logger);
}

async function scanStandardNavLinks(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger
): Promise<MenuItem[]> {
  // Find the navigation container using generic selectors
  const navSelector = await page.evaluate(() => {
    const candidates = [
      'nav',
      'aside',
      '[role="navigation"]',
      '[class*="sidebar"]',
      '[class*="Sidebar"]',
      '[class*="side-nav"]',
      '[class*="sidenav"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.querySelectorAll('a[href]').length > 3) return sel;
    }
    return null;
  });

  if (!navSelector) return [];

  // Expand all collapsed menu groups
  const expandables = page.locator(`${navSelector} [aria-expanded="false"]`);
  const expandCount = await expandables.count();
  for (let i = 0; i < expandCount; i++) {
    try {
      await expandables.nth(i).click();
      await page.waitForTimeout(300);
    } catch { /* Some may not be clickable */ }
  }
  await page.waitForTimeout(500);

  // Extract all menu items
  const baseDomain = new URL(baseUrl).hostname;
  const items = await page.evaluate(
    ({ navSel, domain }: { navSel: string; domain: string }) => {
      const nav = document.querySelector(navSel);
      if (!nav) return [];

      const results: Array<{
        label: string;
        url: string | null;
        level: number;
        selector: string;
      }> = [];

      const links = nav.querySelectorAll('a[href]');
      links.forEach((link) => {
        const anchor = link as HTMLAnchorElement;
        const label = anchor.textContent?.trim() || '';
        const href = anchor.getAttribute('href') || '';
        const fullUrl = anchor.href;

        if (fullUrl && !fullUrl.includes(domain)) return;
        if (href.includes('logout') || href === '#' || href === '') return;
        if (!label) return;

        let level = 0;
        let parent = anchor.parentElement;
        while (parent && parent !== nav) {
          if (parent.tagName === 'UL' || parent.tagName === 'OL' ||
              parent.getAttribute('role') === 'list' || parent.getAttribute('role') === 'group') {
            level++;
          }
          parent = parent.parentElement;
        }
        level = Math.max(0, level - 1);

        const selector = `${navSel} a[href="${href}"]`;
        results.push({ label, url: href, level, selector });
      });

      return results;
    },
    { navSel: navSelector, domain: baseDomain }
  );

  // Build hierarchical menuPath labels
  const flatItems: MenuItem[] = [];
  const parentStack: { label: string; level: number }[] = [];

  for (const item of items) {
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= item.level) {
      parentStack.pop();
    }
    const menuPath = [...parentStack.map((p) => p.label), item.label].join(' > ');
    flatItems.push({ ...item, label: menuPath, children: [] });
    parentStack.push({ label: item.label, level: item.level });
  }

  logger.log('info', 'discovery', {
    menuPath: 'Sidebar',
    element: `Found ${flatItems.length} standard nav links`,
  });
  return flatItems;
}

async function scanIconSidebar(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger,
  sidebarConfig?: CrawlerConfig['sidebar']
): Promise<MenuItem[]> {
  const flatItems: MenuItem[] = [];

  // Auto-detect icon sidebar buttons using generic patterns
  const iconSel = sidebarConfig?.iconSelector
    || await page.evaluate(() => {
      const candidates = [
        // Generic icon-only buttons in sidebar-like containers
        '[class*="sidebar"] button:has(svg)',
        '[class*="Sidebar"] button:has(svg)',
        'aside button:has(svg)',
        'nav button:has(svg)',
        '[role="navigation"] button:has(svg)',
        // List items with icons
        '[class*="sidebar"] [role="button"]:has(svg)',
        'nav [role="menuitem"]',
      ];
      for (const sel of candidates) {
        const items = document.querySelectorAll(sel);
        if (items.length >= 3) {
          const parent = items[0].closest('[class*="sidebar"], [class*="Sidebar"], aside, nav');
          if (parent) {
            const rect = parent.getBoundingClientRect();
            if (rect.width < 100) return sel;
          }
          if (items.length >= 4) return sel;
        }
      }
      return null;
    });

  if (!iconSel) return [];

  const submenuItemSel = sidebarConfig?.submenuItemSelector
    || '[role="menuitem"], [role="link"], li a, li button';
  const submenuTitleSel = sidebarConfig?.submenuTitleSelector
    || 'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="header"] span';

  const iconButtons = page.locator(iconSel);
  const iconCount = await iconButtons.count();
  logger.log('info', 'discovery', {
    menuPath: 'Sidebar',
    element: `Found ${iconCount} sidebar icon categories`,
  });

  for (let i = 0; i < iconCount; i++) {
    try {
      await iconButtons.nth(i).click({ force: true });
      await page.waitForTimeout(500);

      const categoryTitle = await page
        .locator(submenuTitleSel).first()
        .textContent({ timeout: 2000 })
        .then((t) => t?.trim() || `Category ${i + 1}`)
        .catch(() => `Category ${i + 1}`);

      const submenuItems = page.locator(submenuItemSel).filter({ hasText: /.+/ });
      const submenuCount = await submenuItems.count();

      for (let j = 0; j < submenuCount; j++) {
        const itemText = await submenuItems.nth(j).textContent({ timeout: 2000 })
          .then((t) => t?.trim() || '').catch(() => '');
        if (!itemText) continue;

        const urlBefore = page.url();
        try {
          await submenuItems.nth(j).click({ timeout: 3000 });
          await page.waitForFunction(
            (prevUrl: string) => window.location.href !== prevUrl,
            urlBefore, { timeout: 5000 }
          );
          await page.waitForTimeout(300);

          const newUrl = page.url();
          const pathname = new URL(newUrl).pathname;
          if (pathname === new URL(urlBefore).pathname) continue;

          const menuPath = `${categoryTitle} > ${itemText}`;
          flatItems.push({
            label: menuPath, url: pathname, level: 1, children: [],
            selector: `${submenuItemSel}:nth-child(${j + 1})`,
          });
          logger.log('info', 'discovery', { menuPath, url: pathname });

          await page.goBack({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(500);
          await iconButtons.nth(i).click({ force: true });
          await page.waitForTimeout(500);
        } catch {
          logger.log('info', 'skip', {
            menuPath: `${categoryTitle} > ${itemText}`,
            error: 'Navigation failed or placeholder item',
          });
        }
      }
    } catch (err: any) {
      logger.log('warn', 'failed', { menuPath: `Category ${i}`, error: err.message });
    }
  }

  return flatItems;
}

// --- Top Navbar Scanning ---

async function scanTopNavbarItems(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger
): Promise<MenuItem[]> {
  const baseDomain = new URL(baseUrl).hostname;

  const items = await page.evaluate((domain: string) => {
    const nav = document.querySelector('nav') || document.querySelector('header nav');
    if (!nav) return [];

    const results: Array<{ label: string; url: string | null; selector: string }> = [];
    const links = nav.querySelectorAll('a[href], button');

    links.forEach((el) => {
      const label = el.textContent?.trim() || '';
      if (!label) return;

      const href = el.tagName === 'A' ? (el as HTMLAnchorElement).getAttribute('href') : null;
      if (href && href.startsWith('http') && !href.includes(domain)) return;
      if (href === '#' || href === '') return;

      // Build selector using browser-compatible CSS (no Playwright pseudo-selectors)
      let selector: string;
      if (href) {
        selector = `nav a[href="${href}"]`;
      } else {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          selector = `nav ${el.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
        } else {
          // Fallback: use Playwright :text() selector (valid in locator API, not in browser)
          selector = `nav ${el.tagName.toLowerCase()}:text("${label}")`;
        }
      }
      results.push({ label, url: href, selector });
    });

    return results;
  }, baseDomain);

  logger.log('info', 'discovery', {
    menuPath: 'Top Navbar',
    element: `Found ${items.length} nav items`,
  });

  return items.map((item, i) => ({
    ...item,
    level: 0,
    children: [],
    navType: 'top-navbar' as NavType,
  }));
}

// --- Hamburger Menu Scanning ---

async function scanHamburgerItems(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger
): Promise<MenuItem[]> {
  // Find and click hamburger button
  const hamburgerSelectors = [
    '[aria-label*="menu" i]',
    'button:has(svg):near(header)',
    '.hamburger',
    '[class*="hamburger"]',
    'button[class*="menu"]',
  ];

  for (const sel of hamburgerSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(500);

      // Scan the opened menu panel
      const items = await scanStandardNavLinks(page, baseUrl, logger);
      if (items.length > 0) {
        // Close menu
        await page.keyboard.press('Escape');
        return items;
      }
    }
  }

  return [];
}

// --- Tab-Based Navigation ---

async function scanTabNavItems(
  page: Page,
  logger: CrawlerLogger
): Promise<MenuItem[]> {
  const tabs = await page.evaluate(() => {
    const tabList = document.querySelector('[role="tablist"]');
    if (!tabList) return [];

    return Array.from(tabList.querySelectorAll('[role="tab"]')).map((tab, i) => ({
      label: tab.textContent?.trim() || `Tab ${i + 1}`,
      selector: `[role="tablist"] [role="tab"]:nth-child(${i + 1})`,
    }));
  });

  logger.log('info', 'discovery', {
    menuPath: 'Tabs',
    element: `Found ${tabs.length} tabs`,
  });

  return tabs.map((tab) => ({
    label: tab.label,
    url: null,
    level: 0,
    children: [],
    selector: tab.selector,
    navType: 'tab-based' as NavType,
  }));
}

// --- Utils ---

function dedupeMenuItems(items: MenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import './src/navigator.ts'; console.log('navigator OK')"`
Expected: `navigator OK`

- [ ] **Step 3: Commit**

```bash
git add src/navigator.ts
git commit -m "feat: add navigator module with multi-type nav detection"
```

---

### Task 6: Create `src/scanner.ts`

**Files:**
- Create: `src/scanner.ts`

- [ ] **Step 1: Create scanner module with generic DOM selectors**

Extract element scanning from `crawler-script.ts` (lines 499-768). Replace all MUI selectors with generic ones.

```typescript
// src/scanner.ts
import type { Page } from 'playwright';
import type { PageElement, ElementType, NavRegion } from './types.js';
import { CrawlerLogger } from './utils.js';

/**
 * Scan a page for interactive elements using generic DOM selectors.
 * Classification uses text/attribute heuristics, not framework-specific classes.
 */
export async function scanPageElements(
  page: Page,
  baseUrl: string,
  maxElements: number,
  logger: CrawlerLogger,
  menuPath: string,
  navRegion?: NavRegion | null
): Promise<PageElement[]> {
  const baseDomain = new URL(baseUrl).hostname;

  const rawElements = await page.evaluate(
    ({ domain, max, navReg }: { domain: string; max: number; navReg: any }) => {
      // --- Helper: check if element is in navigation area ---
      var isInNav = function(el: Element): boolean {
        // Semantic check
        if (el.closest && el.closest('nav, [role="navigation"], aside')) {
          return true;
        }
        // Positional check using nav region bounding box
        if (navReg) {
          var rect = el.getBoundingClientRect();
          var centerX = rect.left + rect.width / 2;
          var centerY = rect.top + rect.height / 2;
          var regHeight = typeof navReg.height === 'string'
            ? window.innerHeight : navReg.height;
          if (centerX >= navReg.left && centerX <= navReg.left + navReg.width &&
              centerY >= navReg.top && centerY <= navReg.top + regHeight) {
            return true;
          }
        }
        // Positional fallback for narrow left strip
        var rect2 = el.getBoundingClientRect();
        if (rect2.right < 80) return true;
        return false;
      };

      // --- Helper: build robust selector ---
      var buildSelector = function(el: Element): string {
        var testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + testId + '"]';

        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          var sel = el.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        var text = (el.textContent || '').trim();
        if (text && text.length < 50 && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
          return el.tagName.toLowerCase() + ':text("' + text + '")';
        }

        if (el.classList.length > 0) {
          var classSel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).join('.');
          if (document.querySelectorAll(classSel).length === 1) return classSel;
        }

        var path = el.tagName.toLowerCase();
        var parent = el.parentElement;
        while (parent && parent !== document.body) {
          var parentId = parent.getAttribute('id');
          if (parentId) { path = '#' + parentId + ' > ' + path; break; }
          var siblings = parent.children;
          var sameTag = Array.from(siblings).filter(function(s) { return s.tagName === el.tagName; });
          if (sameTag.length > 1) {
            var idx = sameTag.indexOf(el) + 1;
            path = parent.tagName.toLowerCase() + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + idx + ')';
          }
          parent = parent.parentElement;
        }
        return path;
      };

      // --- Helper: visibility check ---
      var isVisible = function(el: Element): boolean {
        var htmlEl = el as HTMLElement;
        if (!htmlEl.offsetParent && htmlEl.tagName !== 'BODY') return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      var results: Array<{
        selector: string; label: string; tagName: string;
        href: string | null; type: string | null;
        ariaLabel: string | null; classList: string[]; role: string | null;
      }> = [];

      // Find content area
      var contentArea = document.querySelector('main, [role="main"], #content, .content, .main-content')
        || document.body;

      // Collect buttons (including a.btn, .button per spec Section 5)
      contentArea.querySelectorAll('button, [role="button"], a.btn, .button, input[type="button"]').forEach(function(el) {
        if (isInNav(el) || !isVisible(el)) return;
        results.push({
          selector: buildSelector(el), label: (el.textContent || '').trim(),
          tagName: el.tagName.toLowerCase(), href: null,
          type: el.getAttribute('type'), ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList), role: el.getAttribute('role'),
        });
      });

      // Collect tabs
      contentArea.querySelectorAll('[role="tab"]').forEach(function(el) {
        if (isInNav(el) || !isVisible(el)) return;
        results.push({
          selector: buildSelector(el), label: (el.textContent || '').trim(),
          tagName: el.tagName.toLowerCase(), href: null, type: null,
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList), role: 'tab',
        });
      });

      // Collect first table row (clickable)
      var firstRow = contentArea.querySelector('table tbody tr:first-child')
        || contentArea.querySelector('[role="row"]:not([role="row"]:first-child)');
      if (firstRow && isVisible(firstRow)) {
        results.push({
          selector: 'table tbody tr:first-child',
          label: 'row[0]', tagName: 'tr', href: null, type: null,
          ariaLabel: null, classList: [], role: 'row',
        });
      }

      // Collect dropdowns
      contentArea.querySelectorAll('select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"]').forEach(function(el) {
        if (isInNav(el) || !isVisible(el)) return;
        results.push({
          selector: buildSelector(el), label: (el.textContent || '').trim(),
          tagName: el.tagName.toLowerCase(), href: null, type: null,
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList), role: 'combobox',
        });
      });

      // Collect internal links (in content area only)
      contentArea.querySelectorAll('a[href]').forEach(function(el) {
        if (isInNav(el) || !isVisible(el)) return;
        var href = (el as HTMLAnchorElement).href;
        if (!href) return;
        results.push({
          selector: buildSelector(el), label: (el.textContent || '').trim(),
          tagName: 'a', href: (el as HTMLAnchorElement).getAttribute('href'),
          type: null, ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList), role: null,
        });
      });

      return results.slice(0, max);
    },
    { domain: baseDomain, max: maxElements, navReg: navRegion || null }
  );

  // Classify each element
  const elements: PageElement[] = [];

  for (const raw of rawElements) {
    const text = (raw.label + ' ' + (raw.ariaLabel || '')).toLowerCase();
    const classStr = raw.classList.join(' ').toLowerCase();

    let type: ElementType;
    let action: PageElement['action'];

    // Classification priority order:
    // 1. action-submit (SKIP)
    // 2. action-danger
    // 3. structural types (tab, table-row, dropdown)
    // 4. external links
    // 5. navigation links
    // 6. action-open (buttons)
    // 7. catch-all → action-open

    if (raw.type === 'submit' || /\b(submit|save|lưu|xác nhận|gửi)\b/i.test(text)) {
      type = 'action-submit';
      action = 'skip';
    } else if (
      /\b(delete|remove|xóa|hủy bỏ|revoke)\b/i.test(text) ||
      classStr.includes('danger') || classStr.includes('destructive') || classStr.includes('delete')
    ) {
      type = 'action-danger';
      action = 'click+cancel';
    } else if (raw.role === 'tab') {
      type = 'tab';
      action = 'click';
    } else if (raw.role === 'row' || raw.selector.includes('tr:first-child')) {
      type = 'table-row';
      action = 'click';
    } else if (raw.role === 'combobox' || raw.tagName === 'select') {
      type = 'dropdown';
      action = 'click+close';
    } else if (raw.href) {
      try {
        const linkDomain = raw.href.startsWith('http') ? new URL(raw.href).hostname : baseDomain;
        if (linkDomain !== baseDomain) {
          type = 'external';
          action = 'skip';
        } else {
          type = 'navigation';
          action = 'click';
        }
      } catch {
        type = 'navigation';
        action = 'click';
      }
    } else if (/\b(create|add|edit|tạo|thêm|sửa|cập nhật|update|filter|lọc|export|import)\b/i.test(text)) {
      type = 'action-open';
      action = 'click+close';
    } else {
      type = 'action-open';
      action = 'click+close';
    }

    elements.push({
      selector: raw.selector,
      label: raw.label || raw.ariaLabel || '(unnamed)',
      type,
      action,
    });
  }

  const clickable = elements.filter((e) => e.action !== 'skip').length;
  logger.log('info', 'discovery', {
    menuPath,
    element: `Found ${elements.length} elements (${clickable} clickable)`,
  });

  return elements;
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import './src/scanner.ts'; console.log('scanner OK')"`
Expected: `scanner OK`

- [ ] **Step 3: Commit**

```bash
git add src/scanner.ts
git commit -m "feat: add scanner module with generic DOM selectors"
```

---

## Chunk 4: Executor & Crawler Orchestrator

### Task 7: Create `src/executor.ts`

**Files:**
- Create: `src/executor.ts`

- [ ] **Step 1: Create executor module with generic modal detection**

Extract execution logic from `crawler-script.ts` (lines 976-1322). Replace MUI modal selectors with generic ones.

```typescript
// src/executor.ts
import type { Page, BrowserContext } from 'playwright';
import type {
  CrawlerConfig, TestPlan, TestPlanPage, PageElement,
  ExecutionResult, ExecutionState, ScreenshotEntry
} from './types.js';
import { CrawlerLogger, waitForPageReady, takeScreenshot } from './utils.js';
import { checkAndRelogin } from './login.js';

// --- Generic Modal Detection ---

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[class*="modal"]',
  '[class*="Modal"]',
  '[class*="drawer"]',
  '[class*="Drawer"]',
  '[class*="dialog"]',
  '[class*="Dialog"]',
  '[class*="popup"]',
];

const MODAL_SELECTOR_STRING = MODAL_SELECTORS.join(', ');

async function isModalOpen(page: Page): Promise<boolean> {
  return page.locator(MODAL_SELECTOR_STRING).first().isVisible().catch(() => false);
}

// --- Generic Close Escalation ---

async function closeModalOrDrawer(
  page: Page,
  pageUrl: string,
  isDanger: boolean,
  logger: CrawlerLogger,
  menuPath: string
): Promise<void> {
  // For danger dialogs, look for Cancel first
  if (isDanger) {
    const cancelBtn = page.locator(
      'button:text("Cancel"), button:text("Hủy"), button:text("Không"), button:text("No")'
    ).first();
    try {
      if (await cancelBtn.isVisible({ timeout: 2000 })) {
        await cancelBtn.click();
        logger.log('info', 'close', { menuPath, element: 'Danger dialog cancelled' });
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* Fall through */ }
  }

  // Step 1: Close button
  const closeSelectors = [
    '[aria-label*="close" i]',
    '[aria-label*="đóng" i]',
    'button:has-text("×")',
    'button:has-text("Close")',
    'button:has-text("Đóng")',
    '.close',
    '.modal-close',
    '[data-dismiss="modal"]',
  ];

  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        logger.log('info', 'close', { menuPath, element: `Closed via ${sel}` });
        await page.waitForTimeout(500);
        if (!(await isModalOpen(page))) return;
      }
    } catch { continue; }
  }

  // Step 2: Cancel button
  const cancelSelectors = [
    'button:has-text("Cancel")',
    'button:has-text("Hủy")',
    'button:has-text("Bỏ qua")',
  ];
  for (const sel of cancelSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        logger.log('info', 'close', { menuPath, element: `Closed via ${sel}` });
        await page.waitForTimeout(500);
        if (!(await isModalOpen(page))) return;
      }
    } catch { continue; }
  }

  // Step 3: Escape key
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  if (!(await isModalOpen(page))) {
    logger.log('info', 'close', { menuPath, element: 'Closed via Escape' });
    return;
  }

  // Step 4: Click backdrop
  const backdropSelectors = ['.modal-backdrop', '.overlay', '[class*="backdrop"]', '[class*="Backdrop"]'];
  for (const sel of backdropSelectors) {
    try {
      const backdrop = page.locator(sel).first();
      if (await backdrop.isVisible({ timeout: 500 })) {
        await backdrop.click({ position: { x: 10, y: 10 }, force: true });
        await page.waitForTimeout(500);
        if (!(await isModalOpen(page))) return;
      }
    } catch { continue; }
  }

  // Step 5: Force navigate back
  logger.log('warn', 'close', { menuPath, error: 'Could not close modal, force navigating' });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page, 5000);
}

// --- Element Interaction ---

async function interactWithElement(
  page: Page,
  element: PageElement,
  config: CrawlerConfig,
  menuPath: string,
  currentUrl: string,
  logger: CrawlerLogger,
  state: ExecutionState
): Promise<ScreenshotEntry | null> {
  if (element.action === 'skip') return null;

  const { timeouts, screenshotDir } = config;
  logger.log('info', 'click', { menuPath, element: element.label, type: element.type });

  try {
    const locator = page.locator(element.selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: timeouts.element });

    switch (element.type) {
      case 'tab': {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(500);
        return takeScreenshot(page, screenshotDir, menuPath, element.label, 'tab', currentUrl, logger, state);
      }

      case 'dropdown': {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(500);
        const shot = await takeScreenshot(page, screenshotDir, menuPath, element.label, 'dropdown', currentUrl, logger, state);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        return shot;
      }

      case 'table-row': {
        const rowLink = page.locator('table tbody tr:first-child a[href]').first();
        const hasLink = await rowLink.isVisible().catch(() => false);
        if (hasLink) {
          await rowLink.click({ timeout: timeouts.element });
        } else {
          await locator.click({ timeout: timeouts.element });
        }
        await waitForPageReady(page, timeouts.navigation);
        const shot = await takeScreenshot(page, screenshotDir, menuPath, 'row0-detail', 'table-row', page.url(), logger, state);
        logger.log('info', 'back', { menuPath });
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        await waitForPageReady(page, timeouts.navigation);
        return shot;
      }

      case 'navigation': {
        await locator.click({ timeout: timeouts.element });
        await waitForPageReady(page, timeouts.navigation);
        const shot = await takeScreenshot(page, screenshotDir, menuPath, element.label, 'navigation', page.url(), logger, state);
        logger.log('info', 'back', { menuPath });
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        await waitForPageReady(page, timeouts.navigation);
        return shot;
      }

      case 'action-danger': {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(1000);
        const shot = await takeScreenshot(page, screenshotDir, menuPath, element.label, 'action-danger', currentUrl, logger, state);
        await closeModalOrDrawer(page, currentUrl, true, logger, menuPath);
        return shot;
      }

      case 'action-open':
      default: {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(1000);
        const modalVisible = await isModalOpen(page);
        const shot = await takeScreenshot(page, screenshotDir, menuPath, element.label, 'action-open', currentUrl, logger, state);
        if (modalVisible) {
          await closeModalOrDrawer(page, currentUrl, false, logger, menuPath);
        }
        return shot;
      }
    }
  } catch (err: any) {
    logger.log('warn', 'timeout', { menuPath, element: element.label, type: element.type, error: err.message });
    return null;
  }
}

// --- Phase 2: Execution ---

export async function runExecution(
  page: Page,
  context: BrowserContext,
  config: CrawlerConfig,
  plan: TestPlan,
  logger: CrawlerLogger
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  const startTime = Date.now();
  const state: ExecutionState = { screenshotCounter: 0 };

  for (const planPage of plan.pages) {
    if (Date.now() - startTime > config.limits.maxDuration) {
      logger.log('warn', 'limit', {
        menuPath: planPage.menuPath,
        error: `maxDuration limit (${config.limits.maxDuration / 60000} min) reached`,
      });
      break;
    }

    const pageStartTime = Date.now();
    const pageResult: ExecutionResult = {
      page: planPage, status: 'pass', duration: 0,
      elementsClicked: 0, elementsFailed: 0, screenshots: [], errors: [],
    };

    try {
      logger.log('info', 'navigate', { menuPath: planPage.menuPath, url: planPage.url });
      await page.goto(`${config.baseUrl}${planPage.url}`, {
        timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded',
      });
      await waitForPageReady(page, config.timeouts.navigation);
      await checkAndRelogin(page, context, config, logger);

      logger.log('info', 'page_load', { menuPath: planPage.menuPath, duration: Date.now() - pageStartTime });

      const pageShot = await takeScreenshot(
        page, config.screenshotDir, planPage.menuPath, null, 'page', planPage.url, logger, state
      );
      pageResult.screenshots.push(pageShot);

      const currentUrl = `${config.baseUrl}${planPage.url}`;

      for (const element of planPage.elements) {
        if (element.action === 'skip') continue;

        let shot = await interactWithElement(page, element, config, planPage.menuPath, currentUrl, logger, state);

        if (!shot) {
          logger.log('info', 'retry', { menuPath: planPage.menuPath, element: element.label, type: element.type });
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
            await waitForPageReady(page, config.timeouts.navigation);
            shot = await interactWithElement(page, element, config, planPage.menuPath, currentUrl, logger, state);
          } catch { /* Retry also failed */ }

          if (!shot) {
            logger.log('error', 'failed', { menuPath: planPage.menuPath, element: element.label, error: 'Failed after retry' });
            pageResult.elementsFailed++;
            pageResult.errors.push(`${element.label} [${element.type}]: failed after retry`);
            continue;
          }
        }

        pageResult.elementsClicked++;
        pageResult.screenshots.push(shot);
      }
    } catch (err: any) {
      logger.log('error', 'failed', { menuPath: planPage.menuPath, error: err.message });
      pageResult.status = 'failed';
      pageResult.errors.push(`Page load: ${err.message}`);

      try {
        logger.log('info', 'retry', { menuPath: planPage.menuPath, element: 'page load' });
        await page.goto(`${config.baseUrl}${planPage.url}`, {
          timeout: config.timeouts.retry, waitUntil: 'domcontentloaded',
        });
        await waitForPageReady(page, config.timeouts.retry);
        pageResult.status = 'pass';
      } catch {
        pageResult.status = 'skipped';
      }
    }

    pageResult.duration = Date.now() - pageStartTime;
    if (pageResult.status !== 'skipped' && pageResult.elementsFailed > 0) {
      pageResult.status = 'issues';
    }
    results.push(pageResult);
  }

  return results;
}
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import './src/executor.ts'; console.log('executor OK')"`
Expected: `executor OK`

- [ ] **Step 3: Commit**

```bash
git add src/executor.ts
git commit -m "feat: add executor module with generic modal detection"
```

---

### Task 8: Create `src/crawler.ts` (main orchestrator)

**Files:**
- Create: `src/crawler.ts`

- [ ] **Step 1: Create main orchestrator**

Wire all modules together. Handle multi-pass AI protocol, session restore, discovery/execution modes.

```typescript
// src/crawler.ts
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  CliInput, CrawlerOutput, TestPlan, NavDetectionResult, LoginSelectors
} from './types.js';
import { CrawlerLogger, restoreSessionState } from './utils.js';
import { login } from './login.js';
import { discoverNavigation, discoverNavigationWithAiResult } from './navigator.js';
import { scanPageElements } from './scanner.js';
import { runExecution } from './executor.js';
import { waitForPageReady } from './utils.js';

async function main(): Promise<void> {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: npx tsx src/crawler.ts <input-file.json>');
    process.exit(1);
  }

  const rawInput = readFileSync(inputArg, 'utf-8');
  const input: CliInput = JSON.parse(rawInput);

  mkdirSync(input.config.screenshotDir, { recursive: true });
  const logger = new CrawlerLogger(input.config.screenshotDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: input.config.viewport });
  const page = await context.newPage();

  try {
    // Restore session from previous pass if available
    if (input.sessionState) {
      logger.log('info', 'login', { menuPath: 'Session', element: 'Restoring session from previous pass...' });
      await restoreSessionState(page, context, input.sessionState, input.config.baseUrl);

      // Check if session is still valid
      const isLoginPage = page.url().includes(input.config.auth.loginPath) || page.url().includes('/login');
      if (isLoginPage) {
        logger.log('warn', 'login', { menuPath: 'Session', error: 'Session expired after restore, re-logging in...' });
        const loginResult = await login(page, context, input.config, logger, input.config.cached?.loginSelectors);
        if (loginResult !== 'success') {
          outputResult(loginResult);
          return;
        }
      }
    }

    // Handle AI result from previous pass
    if (input.aiResult) {
      if (input.aiResult.type === 'login') {
        // AI provided login selectors — login with them
        const selectors = input.aiResult.data as LoginSelectors;
        const loginResult = await login(page, context, input.config, logger, selectors);
        if (loginResult !== 'success') {
          outputResult(loginResult);
          return;
        }
      }
      // Navigation AI result is handled below in discovery
    }

    if (input.mode === 'discover') {
      // Step 1: Login (if not already logged in from session restore or AI result)
      if (!input.sessionState && !input.aiResult) {
        const loginResult = await login(page, context, input.config, logger, input.config.cached?.loginSelectors);
        if (loginResult !== 'success') {
          outputResult(loginResult);
          return;
        }
      }

      // Step 2: Discover navigation
      let menuItems;
      if (input.aiResult?.type === 'navigation') {
        // Use AI-provided nav detection result
        const navResult = input.aiResult.data as NavDetectionResult;
        const aiNavResult = await discoverNavigationWithAiResult(page, context, input.config, logger, navResult);
        if (Array.isArray(aiNavResult)) {
          menuItems = aiNavResult;
        } else {
          // AI retry requested (e.g., wrong nav type, 0 items found)
          outputResult(aiNavResult);
          return;
        }
      } else {
        const navResult = await discoverNavigation(page, context, input.config, logger);
        if (Array.isArray(navResult)) {
          menuItems = navResult;
        } else {
          // needs_ai — exit for SKILL.md to handle
          outputResult(navResult);
          return;
        }
      }

      if (menuItems.length === 0) {
        outputResult({ status: 'error', error: 'No menu items found. Check navigation config or app state.' });
        return;
      }

      // Step 3: Scan elements on each page
      const startTime = Date.now();
      const pages = [];
      let pageIndex = 0;
      let skippedExternal = 0;
      let skippedSubmit = 0;

      for (const item of menuItems) {
        if (pageIndex >= input.config.limits.maxPages) {
          logger.log('warn', 'limit', { menuPath: item.label, error: `maxPages limit reached` });
          break;
        }
        if (!item.url) continue;

        try {
          logger.log('info', 'navigate', { menuPath: item.label, url: item.url });
          await page.goto(`${input.config.baseUrl}${item.url}`, {
            timeout: input.config.timeouts.navigation, waitUntil: 'domcontentloaded',
          });
          await waitForPageReady(page, input.config.timeouts.navigation);

          const elements = await scanPageElements(
            page, input.config.baseUrl, input.config.limits.maxElementsPerPage,
            logger, item.label, input.config.cached?.navRegion
          );

          skippedExternal += elements.filter((e) => e.type === 'external').length;
          skippedSubmit += elements.filter((e) => e.type === 'action-submit').length;

          pages.push({
            index: pageIndex, menuPath: item.label, url: item.url,
            source: 'menu' as const, elements,
          });
          pageIndex++;
        } catch (err: any) {
          logger.log('error', 'failed', { menuPath: item.label, error: err.message });
        }
      }

      const totalElements = pages.reduce((sum, p) => sum + p.elements.length, 0);
      const clickableElements = pages.reduce(
        (sum, p) => sum + p.elements.filter((e) => e.action !== 'skip').length, 0
      );
      const discoveryTime = Date.now() - startTime;
      const estimatedExecution = clickableElements * 3000;
      const totalEstimate = discoveryTime + estimatedExecution;

      const testPlan: TestPlan = {
        generatedAt: new Date().toISOString(),
        baseUrl: input.config.baseUrl,
        totalPages: pages.length,
        totalElements,
        estimatedDuration: `~${Math.ceil(totalEstimate / 60000)} minutes`,
        pages,
        skippedExternal,
        skippedSubmit,
      };

      outputResult({ status: 'test_plan', testPlan });

    } else if (input.mode === 'execute') {
      if (!input.testPlan) throw new Error('testPlan required for execute mode');

      // Login first if no session
      if (!input.sessionState) {
        const loginResult = await login(page, context, input.config, logger, input.config.cached?.loginSelectors);
        if (loginResult !== 'success') {
          outputResult(loginResult);
          return;
        }
      }

      const results = await runExecution(page, context, input.config, input.testPlan, logger);
      const totalScreenshots = results.reduce((sum, r) => sum + r.screenshots.length, 0);

      outputResult({
        status: 'execution_result',
        results,
        totalScreenshots,
        logFile: join(input.config.screenshotDir, 'crawler.log'),
      });
    }
  } catch (err: any) {
    outputResult({ status: 'error', error: err.message });
  } finally {
    await browser.close();
  }
}

function outputResult(result: CrawlerOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

main();
```

- [ ] **Step 2: Verify compile**

Run: `npx tsx --eval "import { readFileSync } from 'fs'; console.log('crawler imports OK')"`
Expected: `crawler imports OK`

- [ ] **Step 3: Commit**

```bash
git add src/crawler.ts
git commit -m "feat: add main crawler orchestrator with multi-pass AI protocol"
```

---

## Chunk 5: SKILL.md, Analyze Prompt & Cleanup

### Task 9: Update `analyze-prompt.md`

**Files:**
- Modify: `analyze-prompt.md`

- [ ] **Step 1: Remove MUI-specific references, add generic checks**

Replace all MUI references with generic equivalents:
- `.MuiOutlinedInput` → "floating label"
- `.MuiDialog` / `.MuiDrawer` → "modal/dialog/drawer"
- `.MuiTab-root` → "[role=tab]"
- Add top navbar alignment checks
- Add hamburger menu transition checks

Search and replace in `analyze-prompt.md`:
- Replace `MUI Outlined TextFields/Selects have a floating label that sits on the top border` → `Some frameworks (MUI, Ant Design, Bootstrap) use floating labels that sit on the top border of input fields`
- Replace `MUI Outlined label rendering` → `Floating label rendering`
- Remove `.MuiContainer-root`, `.MuiBox-root`, `.MuiDataGrid-row` references
- Keep all generic checks unchanged (overlap, containment, typography, spacing, badges, error exposure)

- [ ] **Step 2: Commit**

```bash
git add analyze-prompt.md
git commit -m "feat: make analyze prompt framework-agnostic"
```

---

### Task 10: Update `SKILL.md`

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Update SKILL.md for multi-pass AI protocol**

Key changes:
1. Update entry point path: `crawler-script.ts` → `src/crawler.ts`
2. Add `needs_ai` response handling logic after running crawler
3. Add AI subagent dispatch flow for login and navigation detection
4. Add session state forwarding between passes
5. Update config setup to mention `cached` field

Replace the crawler invocation sections (Steps 2 and 4) to handle the new output format:

```markdown
### Step 2: Run Discovery (Phase 1)

Write a JSON input file and run the crawler in discovery mode:

\`\`\`bash
cat > /tmp/visual-test-discovery-input.json << 'ENDJSON'
{
  "mode": "discover",
  "config": { ... full config object ... }
}
ENDJSON

npx tsx <skill-dir>/src/crawler.ts /tmp/visual-test-discovery-input.json
\`\`\`

The crawler outputs JSON to stdout. Parse the `status` field:

**If `status === "needs_ai"`:**
1. Read `aiRequest.screenshot` — the screenshot file path
2. Read `aiRequest.type` — either "login" or "navigation"
3. Dispatch an AI subagent:
   - Have the subagent read the screenshot file
   - Provide `aiRequest.prompt` as the instruction
   - Parse the AI response as JSON
4. Write a new input file with the AI result and session state:
   \`\`\`json
   {
     "mode": "discover",
     "config": { ... },
     "aiResult": { "type": "login", "data": { AI response JSON } },
     "sessionState": { ... from crawler output ... }
   }
   \`\`\`
5. Re-run the crawler with the new input file
6. Repeat until status is "test_plan" or "error"

**If `status === "test_plan"`:** proceed to Step 3.
**If `status === "error"`:** show error to user and stop.
```

- [ ] **Step 2: Update Step 4 (execution) similarly**

Update the execution step to pass session state and handle the new output format.

- [ ] **Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat: update SKILL.md for multi-pass AI protocol"
```

---

### Task 11: Update `guide.md` and `README.md`

**Files:**
- Modify: `guide.md`
- Modify: `README.md`

- [ ] **Step 1: Update guide.md**

- Remove MUI-specific references
- Add section about supported navigation types (sidebar, top navbar, hamburger, tabs)
- Update "Cấu trúc skill" section to show `src/` module structure
- Add note about AI-assisted detection for non-standard login/navigation

- [ ] **Step 2: Update README.md**

- Update "Skill Structure" section to show `src/` modules
- Add "Supported Navigation Types" section
- Add "AI-Assisted Detection" section explaining the heuristic-first, AI-fallback approach
- Update installation instructions (copy `src/` directory too)

- [ ] **Step 3: Commit**

```bash
git add guide.md README.md
git commit -m "docs: update guide and README for generic framework support"
```

---

### Task 12: Delete old monolith and update package.json

**Files:**
- Delete: `crawler-script.ts`
- Modify: `package.json`

- [ ] **Step 1: Update package.json with proper metadata**

```json
{
  "name": "smart-crawler-visual-testing",
  "version": "2.0.0",
  "description": "Claude Code skill for automated UI visual testing — crawls any admin panel, screenshots every state, and AI-analyzes for layout bugs",
  "keywords": [
    "claude-code", "skill", "visual-testing", "ui-testing",
    "playwright", "screenshot", "crawler", "admin-panel"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/hoadinh2010/smart-crawler-visual-testing.git"
  },
  "dependencies": {
    "playwright": "^1.58.2"
  }
}
```

- [ ] **Step 2: Delete old monolith**

```bash
git rm crawler-script.ts
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: remove monolith, bump to v2.0.0 for generic framework support"
```

---

### Task 13: Push to remote

- [ ] **Step 1: Push all changes**

```bash
git push origin main
```

- [ ] **Step 2: Update global skill symlink**

```bash
rm -rf ~/.claude/skills/visual-testing/src
cp -r /Users/hoadinh/Sites/smart-crawler-visual-testing/src ~/.claude/skills/visual-testing/src
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/SKILL.md ~/.claude/skills/visual-testing/SKILL.md
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/analyze-prompt.md ~/.claude/skills/visual-testing/analyze-prompt.md
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/guide.md ~/.claude/skills/visual-testing/guide.md
cd ~/.claude/skills/visual-testing && npm install
```
