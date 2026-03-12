# Generic Visual Testing Skill — Implementation Plan (Skill-First)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the visual testing skill framework-agnostic. Support any admin panel with login, any navigation type.

**Architecture:** Keep `crawler-script.ts` as a **dumb executor** — it receives selectors/URLs and executes (click, screenshot, close). All intelligence lives in **SKILL.md** — Claude AI screenshots pages, decides what to click, identifies login fields, detects navigation type.

**Key insight:** This is a Claude Code skill. The power comes from AI reasoning about screenshots, not from complex TypeScript heuristics.

**Spec:** [docs/superpowers/specs/2026-03-12-generic-visual-testing-design.md](../specs/2026-03-12-generic-visual-testing-design.md)

---

## What changes, what stays

**Keep:**
- Single `crawler-script.ts` file (no modular split — it's ~1,400 lines of straightforward Playwright automation)
- Two-phase flow: discover → execute
- Element interaction logic (click, screenshot, close modal, retry)
- Logging, screenshot naming, test plan formatting

**Change in `crawler-script.ts`:**
- Replace MUI-specific login selectors → accept selectors from input JSON
- Replace MUI sidebar detection → accept menu items from input JSON
- Replace MUI-specific element selectors → generic DOM selectors
- Replace MUI modal detection → generic modal selectors
- Add `"login-detect"` mode: just navigate to login page + screenshot, exit
- Add `"nav-detect"` mode: just screenshot post-login page, exit

**Change in `SKILL.md`:**
- Add AI login detection: screenshot login page → Claude identifies fields → pass selectors to crawler
- Add AI navigation detection: screenshot post-login → Claude identifies nav type + menu items → pass to crawler
- Multi-pass orchestration: SKILL.md runs crawler in detect modes → Claude reasons → runs crawler in discover/execute modes

**Change in `analyze-prompt.md`:**
- Remove MUI-specific references, make generic

---

## Chunk 1: Generic Crawler Script

### Task 1: Make login accept selectors from input

**Files:**
- Modify: `crawler-script.ts:157-194`

- [ ] **Step 1: Update CrawlerConfig auth type**

Add optional selector fields to the `auth` interface (line 9-16):

```typescript
auth: {
  loginPath: string;
  username: string;
  password: string;
  postLoginPath?: string;
  successUrlPattern?: string;
  // Selectors detected by AI (SKILL.md fills these in config after first run)
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
};
```

- [ ] **Step 2: Replace hardcoded MUI login with generic login**

Replace the `login` function (lines 157-194):

```typescript
async function login(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<void> {
  const { baseUrl, auth, timeouts } = config;
  logger.log('info', 'login', { menuPath: 'Login', url: `${baseUrl}${auth.loginPath}` });

  await page.goto(`${baseUrl}${auth.loginPath}`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Use selectors from config (provided by SKILL.md after AI detection)
  const userSel = auth.usernameSelector || 'input[type="email"], input[type="text"]';
  const passSel = auth.passwordSelector || 'input[type="password"]';
  const submitSel = auth.submitSelector || 'button[type="submit"]';

  await page.locator(userSel).first().fill(auth.username);
  await page.locator(passSel).first().fill(auth.password);
  await page.locator(submitSel).first().click();

  const successPattern = auth.successUrlPattern || '**/admin**';
  await page.waitForURL(successPattern, { timeout: timeouts.navigation }).catch(() => {
    if (page.url().includes(auth.loginPath)) {
      throw new Error('Login failed. Check credentials.');
    }
  });

  if (auth.postLoginPath) {
    logger.log('info', 'login', { menuPath: 'Login', element: `Navigating to ${auth.postLoginPath}...` });
    await page.goto(`${baseUrl}${auth.postLoginPath}`, {
      waitUntil: 'domcontentloaded', timeout: timeouts.navigation,
    });
    await page.waitForTimeout(2000);
  }

  logger.log('info', 'login', { menuPath: 'Login', element: 'Login successful' });
}
```

- [ ] **Step 3: Commit**

```bash
git add crawler-script.ts
git commit -m "feat: make login accept selectors from config"
```

---

### Task 2: Make element scanning generic

**Files:**
- Modify: `crawler-script.ts:499-768`

- [ ] **Step 1: Replace MUI selectors in `isInNav`** (line 531-552)

```typescript
// OLD: el.closest('nav, [role="navigation"], .MuiDrawer-root, .MuiDrawer-paper, aside')
// NEW:
el.closest('nav, [role="navigation"], aside, [class*="sidebar"], [class*="Sidebar"]')
```

Remove MUI parent walk checks (lines 546-548):
```typescript
// Remove: parent.classList.contains('MuiDrawer-root') || parent.classList.contains('MuiDrawer-paper')
```

- [ ] **Step 2: Add content area scoping** (before line 602)

```typescript
var contentArea = document.querySelector('main, [role="main"], #content, .content, .main-content')
  || document.body;
```

Then scope all `document.querySelectorAll(...)` calls to `contentArea.querySelectorAll(...)`.

- [ ] **Step 3: Replace MUI-specific selectors**

Tab collection (line 622):
```typescript
// OLD: '[role="tab"], .MuiTab-root'
// NEW:
'[role="tab"]'
```

Table row (lines 638-654):
```typescript
// OLD: document.querySelector('.MuiDataGrid-row:first-child')
// NEW: remove MuiDataGrid, keep only:
var firstRow = contentArea.querySelector('table tbody tr:first-child');
```

Dropdowns (line 657):
```typescript
// OLD: 'select, .MuiSelect-root, [role="combobox"]'
// NEW:
'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"]'
```

Links (line 673):
```typescript
// OLD: 'main a[href], .MuiContainer-root a[href], [role="main"] a[href]'
// NEW:
contentArea.querySelectorAll('a[href]')
```

Danger classification (line 717):
```typescript
// OLD: classStr.includes('containederror') || classStr.includes('color-error')
// NEW:
classStr.includes('danger') || classStr.includes('destructive') || classStr.includes('delete')
```

Dropdown classification (line 726):
```typescript
// OLD: classStr.includes('muiselect')
// NEW: remove muiselect check
```

- [ ] **Step 4: Commit**

```bash
git add crawler-script.ts
git commit -m "feat: replace MUI selectors with generic DOM selectors"
```

---

### Task 3: Make modal detection and page ready generic

**Files:**
- Modify: `crawler-script.ts:772-795, 976-1042, 1140-1160`

- [ ] **Step 1: Define generic modal selector constant** (add near top of file, after types)

```typescript
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="drawer" i], [class*="dialog" i]';
```

- [ ] **Step 2: Update `waitForPageReady`** (lines 776-781)

```typescript
async function waitForPageReady(page: Page, timeout: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});

  const contentSelectors = ['main', '[role="main"]', '#app > *', '#root > *', '.content'];
  await Promise.any(
    contentSelectors.map(sel => page.waitForSelector(sel, { state: 'visible', timeout: 3000 }).then(() => true))
  ).catch(() => false);

  await page.waitForTimeout(500);
}
```

- [ ] **Step 3: Update `closeModalOrDrawer`** (lines 1001-1010, 1021, 1032)

Replace close selectors:
```typescript
const closeSelectors = [
  '[aria-label*="close" i]',
  '[aria-label*="đóng" i]',
  'button:has-text("×")',
  'button:has-text("Close")',
  'button:has-text("Đóng")',
  'button:has-text("Cancel")',
  'button:has-text("Hủy")',
  '.close',
  '.modal-close',
  '[data-dismiss="modal"]',
];
```

Replace modal-open checks:
```typescript
// OLD: '.MuiModal-root, .MuiDialog-root, .MuiDrawer-root .MuiDrawer-paper'
// NEW:
MODAL_SELECTOR
```

- [ ] **Step 4: Update modal detection in `interactWithElement`** (line 1148)

```typescript
// OLD: '.MuiModal-root, .MuiDialog-root, .MuiDrawer-root .MuiDrawer-paper, [role="dialog"]'
// NEW:
MODAL_SELECTOR
```

- [ ] **Step 5: Commit**

```bash
git add crawler-script.ts
git commit -m "feat: generic modal detection and page ready"
```

---

### Task 4: Make sidebar scanning generic

**Files:**
- Modify: `crawler-script.ts:196-497`

- [ ] **Step 1: Update `autoDetectIconSelector`** (lines 319-345)

Replace MUI candidates:
```typescript
const candidates = [
  '[class*="sidebar"] button:has(svg)',
  '[class*="Sidebar"] button:has(svg)',
  'aside button:has(svg)',
  'nav button:has(svg)',
  '[role="navigation"] button:has(svg)',
];
```

Replace parent check (line 335):
```typescript
// OLD: el.closest('[class*="sidebar"], [class*="Sidebar"], .MuiDrawer-root, .MuiBox-root')
// NEW:
el.closest('[class*="sidebar"], [class*="Sidebar"], aside, nav')
```

- [ ] **Step 2: Update `scanStandardSidebar`** (lines 355-368)

Replace nav container candidates:
```typescript
const candidates = [
  'nav',
  'aside',
  '[role="navigation"]',
  '[class*="sidebar"]',
  '[class*="Sidebar"]',
];
```

Replace list level detection (line 411):
```typescript
// OLD: parent.classList.contains('MuiList-root')
// NEW:
parent.getAttribute('role') === 'list' || parent.getAttribute('role') === 'group'
```

- [ ] **Step 3: Update `scanIconSidebar` submenu selectors** (line 222)

```typescript
const submenuItemSel = sidebarConfig?.submenuItemSelector
  || '[role="menuitem"], [role="link"], li a, li button, [class*="menu-item"], [class*="MenuItem"]';
```

- [ ] **Step 4: Update `scanSidebar` nav detection** (lines 462-463)

```typescript
// OLD: const navCandidates = ['nav', '.MuiDrawer-root', 'aside', '[role="navigation"]'];
// NEW:
const navCandidates = ['nav', 'aside', '[role="navigation"]', '[class*="sidebar"]'];
```

- [ ] **Step 5: Commit**

```bash
git add crawler-script.ts
git commit -m "feat: generic sidebar detection"
```

---

### Task 5: Add detect modes to crawler

**Files:**
- Modify: `crawler-script.ts:1326-1387`

- [ ] **Step 1: Update `CliInput` type** (line 1327)

```typescript
interface CliInput {
  mode: 'discover' | 'execute' | 'login-detect' | 'nav-detect';
  config: CrawlerConfig;
  testPlan?: TestPlan;
}
```

- [ ] **Step 2: Add mode handlers in `main()`** (before existing if/else, around line 1354)

```typescript
if (input.mode === 'login-detect') {
  // Screenshot login page for Claude to analyze
  const { baseUrl, auth } = input.config;
  await page.goto(`${baseUrl}${auth.loginPath}`, { timeout: input.config.timeouts.navigation });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  const screenshotPath = join(input.config.screenshotDir, 'login-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({ status: 'login-screenshot', screenshot: screenshotPath }));

} else if (input.mode === 'nav-detect') {
  // Login then screenshot for Claude to analyze navigation
  await login(page, input.config, logger);
  const screenshotPath = join(input.config.screenshotDir, 'post-login-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({ status: 'nav-screenshot', screenshot: screenshotPath }));

} else if (input.mode === 'discover') {
  // ... existing discover logic
} else if (input.mode === 'execute') {
  // ... existing execute logic
}
```

- [ ] **Step 3: Commit**

```bash
git add crawler-script.ts
git commit -m "feat: add login-detect and nav-detect modes for AI"
```

---

## Chunk 2: SKILL.md — Claude as Brain

### Task 6: Update SKILL.md with AI detection flow

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Add Step 1.5 — AI Login Detection**

Insert after Step 1 (Config Setup), before Step 2 (Discovery):

```markdown
### Step 1.5: AI Login Detection (first run only)

If `auth.usernameSelector` is NOT set in config:

1. Run crawler in login-detect mode:
\`\`\`bash
cat > /tmp/visual-test-login-detect.json << 'ENDJSON'
{ "mode": "login-detect", "config": { ... config ... } }
ENDJSON
npx tsx <skill-dir>/crawler-script.ts /tmp/visual-test-login-detect.json
\`\`\`

2. Parse the output JSON — read the `screenshot` path.

3. Read the screenshot file. Look at it carefully and identify:
   - The username/email input field → determine its CSS selector
   - The password input field → determine its CSS selector
   - The submit/login button → determine its CSS selector

4. Update config with the detected selectors:
\`\`\`json
"auth": {
  ...existing fields...,
  "usernameSelector": "<selector you identified>",
  "passwordSelector": "<selector you identified>",
  "submitSelector": "<selector you identified>"
}
\`\`\`

5. Write the updated config to `.claude/visual-test.config.json`.

6. If you cannot identify the login form from the screenshot, ask the user.
```

- [ ] **Step 2: Add nav detection fallback to Step 2**

Add after the discovery run, if 0 menu items found:

```markdown
**If discovery returns 0 menu items:**

1. Run crawler in nav-detect mode:
\`\`\`bash
cat > /tmp/visual-test-nav-detect.json << 'ENDJSON'
{ "mode": "nav-detect", "config": { ... config ... } }
ENDJSON
npx tsx <skill-dir>/crawler-script.ts /tmp/visual-test-nav-detect.json
\`\`\`

2. Read the screenshot. Identify the navigation type and structure:
   - Is it a sidebar (left/right), top navbar, hamburger menu, or tabs?
   - What menu items are visible?
   - For hamburger menus: what selector opens it?

3. If it's a non-standard sidebar (icon-only), add `sidebar` config:
\`\`\`json
"sidebar": {
  "iconSelector": "<selector>",
  "submenuItemSelector": "<selector>"
}
\`\`\`

4. Update config and re-run discovery.
```

- [ ] **Step 3: Update crawler path references**

Ensure all `npx tsx` commands use the skill-relative path pattern:
```
npx tsx <skill-dir>/crawler-script.ts <input-file>
```
Where `<skill-dir>` is resolved to the skill's installation directory (e.g., `~/.claude/skills/visual-testing/` or `.claude/skills/visual-testing/`).

- [ ] **Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat: add AI login/nav detection to SKILL.md"
```

---

## Chunk 3: Analyze Prompt & Docs

### Task 7: Update analyze-prompt.md

**Files:**
- Modify: `analyze-prompt.md`

- [ ] **Step 1: Replace all MUI-specific text**

Search and replace:
- `MUI Outlined TextFields/Selects have a floating label that sits on the top border` → `Some UI frameworks (MUI, Ant Design, Bootstrap) use floating labels that sit on the top border of input fields`
- `MUI Outlined label rendering:` → `Floating label rendering:`
- `MUI Outlined label` → `Floating label` (all occurrences)
- Remove any remaining `MUI` references — replace with generic equivalents
- Keep all the actual checks (they're already mostly generic — overlap, spacing, typography, etc.)

- [ ] **Step 2: Commit**

```bash
git add analyze-prompt.md
git commit -m "feat: make analyze prompt framework-agnostic"
```

---

### Task 8: Update guide.md and README.md

**Files:**
- Modify: `guide.md`
- Modify: `README.md`

- [ ] **Step 1: Update guide.md**

- Add note: skill works with any UI framework (MUI, Ant Design, Chakra, Tailwind, Bootstrap, custom)
- Add "Supported navigation types" list
- Note that Claude auto-detects login form on first run
- Remove any MUI-specific language

- [ ] **Step 2: Update README.md**

- Update "How It Works" to mention AI login detection
- Add "Supported Frameworks" list
- Update installation path

- [ ] **Step 3: Commit**

```bash
git add guide.md README.md
git commit -m "docs: update for generic framework support"
```

---

### Task 9: Bump version and push

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

```json
{
  "version": "2.0.0",
  "description": "Claude Code skill for automated UI visual testing — crawls any admin panel, screenshots every state, and AI-analyzes for layout bugs",
  "repository": {
    "type": "git",
    "url": "https://github.com/hoadinh2010/smart-crawler-visual-testing.git"
  }
}
```

- [ ] **Step 2: Commit and push**

```bash
git add package.json
git commit -m "chore: bump to v2.0.0 for generic framework support"
git push origin main
```

- [ ] **Step 3: Update global skill**

```bash
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/crawler-script.ts ~/.claude/skills/visual-testing/crawler-script.ts
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/SKILL.md ~/.claude/skills/visual-testing/SKILL.md
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/analyze-prompt.md ~/.claude/skills/visual-testing/analyze-prompt.md
cp /Users/hoadinh/Sites/smart-crawler-visual-testing/guide.md ~/.claude/skills/visual-testing/guide.md
```
