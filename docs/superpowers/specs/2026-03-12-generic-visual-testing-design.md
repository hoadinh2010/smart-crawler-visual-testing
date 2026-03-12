# Generic Visual Testing Skill — Design Spec

**Date:** 2026-03-12
**Status:** Approved
**Goal:** Refactor the visual testing skill from MUI-specific to framework-agnostic, supporting any admin panel with login + multi-page navigation.

---

## 1. Scope

**In scope:**
- Admin panels and dashboards with login
- Multiple navigation types: sidebar (left/right), top navbar, hamburger menu, tab-based, mixed
- Any UI framework: MUI, Ant Design, Chakra, Tailwind, Bootstrap, custom CSS
- AI-assisted login detection and navigation type detection
- Heuristic-based element scanning (no AI per-page, keeps speed)
- Modular rewrite of `crawler-script.ts` into focused modules

**Out of scope:**
- Landing pages, e-commerce storefronts, blogs (no login flow)
- SPA routing without navigation menus
- Mobile app testing
- Full AI-controlled crawling (too slow, too expensive)

---

## 2. Architecture

### Module Structure

```
smart-crawler-visual-testing/
  SKILL.md              — orchestrator (multi-pass, AI dispatch)
  analyze-prompt.md     — generic UI analysis prompt (5-pass scan)
  guide.md              — usage guide (Vietnamese)
  README.md             — documentation (English)
  package.json          — metadata + playwright dependency
  .gitignore
  src/
    types.ts            — shared interfaces
    crawler.ts          — orchestrator (discover/execute modes, entry point)
    login.ts            — heuristic login + AI-assisted fallback
    navigator.ts        — AI nav detection + heuristic menu scanning
    scanner.ts          — generic DOM element scanner + classification
    executor.ts         — element interaction + screenshot + modal close
    ai-vision.ts        — needs_ai protocol, request/response formatting
    utils.ts            — logging, retry, timeout, screenshot naming
```

### Entry Point

```bash
# Current
npx tsx crawler-script.ts input.json

# New
npx tsx src/crawler.ts input.json
```

### Data Flow

```
SKILL.md
  ├─ writes input JSON (config + mode + optional AI results)
  ├─ calls: src/crawler.ts input.json
  ├─ reads stdout JSON output
  ├─ if output.status === "needs_ai":
  │     dispatch AI subagent → get result → update input JSON → re-run crawler
  ├─ if output.status === "test_plan":
  │     show to user → get approval → run execution pass
  └─ if output.status === "execution_result":
        dispatch analyze subagents → generate report

src/crawler.ts (orchestrator)
  ├─ reads input JSON
  ├─ calls login.ts → login flow
  ├─ calls navigator.ts → nav discovery
  ├─ calls scanner.ts → element scanning per page
  ├─ calls executor.ts → element interaction + screenshots
  ├─ calls ai-vision.ts → format AI requests when needed
  └─ outputs JSON to stdout
```

---

## 3. Login Flow (`login.ts`)

### Step 1: Heuristic Login (try first, fast)

1. Navigate to `config.auth.loginPath`
2. Find form fields using generic selectors in priority order:
   - Username: `input[type="email"]`, `input[type="text"][name*="user"]`, `input[name*="email"]`, `input[name*="login"]`
   - Password: `input[type="password"]`
   - Submit: `button[type="submit"]`, `button:has-text("Login")`, `button:has-text("Sign in")`, `button:has-text("Log in")`
3. If all 3 found → fill credentials → submit → verify redirect
4. If login succeeds → done, skip AI

### Step 2: AI-Assisted Login (fallback when heuristic fails)

1. Screenshot the login page
2. Crawler outputs: `{ "status": "needs_ai", "aiRequest": { "type": "login", "screenshot": "/path/to/login.png" } }`
3. SKILL.md dispatches AI subagent with screenshot: "Identify the username field, password field, and submit button. Return CSS selectors."
4. AI returns: `{ "usernameSelector": "...", "passwordSelector": "...", "submitSelector": "..." }`
5. SKILL.md writes selectors into input JSON → re-runs crawler
6. Crawler uses selectors → fill → submit → verify
7. Save selectors to config `cached.loginSelectors` for next run

### Login Verification

- Check URL matches `config.auth.successUrlPattern` (default: `**/admin**`)
- Or check DOM: nav/sidebar appears, login form disappears
- Timeout: 15s → fail

---

## 4. Navigation Discovery (`navigator.ts`)

### Step 1: Heuristic Navigation Detection (try first, fast)

1. After successful login, scan the DOM for common navigation patterns:
   - **Sidebar detection**: find `nav`, `aside`, `[role="navigation"]` with vertical orientation. Check if element is narrow (<300px wide) and tall (>= 80% of viewport height, to account for sidebars below a header). Distinguish icon-only (width <100px) vs text sidebar.
   - **Top navbar detection**: find `nav`, `header` with horizontal orientation at top of page.
   - **Hamburger detection**: find `[aria-label*="menu"]`, `button:has(svg)` in header area with no visible nav links.
2. If a clear navigation pattern is found → determine `navType` and `region` from DOM geometry → proceed to Step 3.
3. If no navigation found or ambiguous → fall through to Step 2 (AI).

### Step 2: AI-Assisted Navigation Detection (fallback when heuristic fails)

1. Take full-page screenshot
2. Crawler outputs: `{ "status": "needs_ai", "aiRequest": { "type": "navigation", "screenshot": "/path/to/post-login.png" } }`
3. SKILL.md dispatches AI subagent: "Identify the navigation pattern: type (sidebar-left, sidebar-right, top-navbar, hamburger, tab-based, mixed), approximate region, text vs icon-only, nesting type."
4. AI returns:
   ```json
   {
     "navType": "sidebar-left",
     "region": { "top": 0, "left": 0, "width": 240, "height": "100%" },
     "hasText": true,
     "hasNesting": true,
     "nestingType": "accordion"
   }
   ```
5. **Validate AI response**: verify returned `navType` is one of the expected enum values, `region` has valid dimensions within viewport bounds. If invalid → retry once, then fail with descriptive error.
6. Save to config `cached.navType`, `cached.navRegion` for next run

### Step 3: Heuristic Menu Item Scanning (per navType)

**sidebar-left / sidebar-right:**
- Scope queries to nav region → find all `<a>`, `<button>`, `[role="menuitem"]`
- If `hasNesting`: click parent → wait for submenu → scan children → DFS

**top-navbar:**
- Find `<nav>` or `<header>` → scan `<a>`, `<button>` inside
- Hover/click to open dropdown submenus

**hamburger:**
- Find hamburger button: `[aria-label*="menu"]`, `.hamburger`, button with ☰ icon, button with 3-line pattern
- Click → wait for menu panel → scan items inside

**tab-based:**
- Find `[role="tablist"]` → scan `[role="tab"]` items
- Each tab may contain sub-navigation

**mixed:**
- Run multiple strategies → merge results → dedupe by URL

**Output:** `MenuItem[]` with `label`, `url`, `level`, `children`, `selector`, `navType`

---

## 5. Element Scanner (`scanner.ts`)

### Generic DOM Selectors

```
Buttons:    button, [role="button"], a.btn, .button, input[type="button"]
Links:      a[href] (in content area, not nav)
Tabs:       [role="tab"], [data-tab], .tab, .nav-tab
Dropdowns:  select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"]
Table rows: table tbody tr, [role="row"]
Inputs:     input, textarea, [role="textbox"], [contenteditable="true"]
```

### Classification Heuristic

| Type | Detection Rules |
|------|----------------|
| `action-danger` | Text matches `/delete\|remove\|xóa\|hủy bỏ\|revoke/i`, or class contains "danger"/"destructive"/"delete" |
| `action-submit` | Text matches `/save\|submit\|lưu\|create\|tạo\|update\|cập nhật/i`, or `type="submit"` |
| `action-open` | Text matches `/add\|new\|edit\|view\|chi tiết\|thêm/i`, or button that's not submit/danger/link |
| `navigation` | `<a>` with href different from current page, not in nav area |
| `tab` | `[role="tab"]` or matches tab patterns |
| `table-row` | `<tr>` or `[role="row"]` with click handler |
| `dropdown` | `<select>` or `[role="combobox"]` |
| `external` | `<a>` with href starting http and different domain |

### Content Area vs Nav Area Detection

The scanner must distinguish content elements from navigation elements to avoid duplicate scanning.

**Nav area identification** (using data from `navigator.ts`):
- Use `cached.navRegion` bounding box — any element whose center falls within this region is considered nav
- Additionally check semantic markers: elements inside `nav`, `aside`, `[role="navigation"]` tags

**Content area identification:**
- Primary: `main`, `[role="main"]`, `#content`, `.content`, `.main-content`
- Fallback: largest visible block element that is not nav, header, or footer
- If no content area found: use full viewport minus nav region

Scanner scopes all element queries to the identified content area.

### Filtering

- Skip invisible elements (`display:none`, `visibility:hidden`, zero dimensions)
- Skip elements inside nav area (identified by `navRegion` bounding box + semantic tags)
- Skip disabled elements
- Dedupe elements with same text + same type
- Respect `limits.maxElementsPerPage`

---

## 6. Executor (`executor.ts`)

### Retained from Current Implementation

- Click strategy per element type (navigation → click → screenshot → back, action-open → click → screenshot modal → close, etc.)
- Screenshot capture + structured naming
- Retry logic on click failure
- Session re-login detection
- JSONL logging to `crawler.log`

### Page Ready Detection (`utils.ts`)

After every navigation, wait for page to be interactive:

1. `page.waitForLoadState('networkidle')` with 10s timeout
2. Then check for content presence using generic selectors in order:
   - `main`, `[role="main"]`, `#app > *`, `#root > *`, `.content`, `[class*="layout"]`
3. If none found within 3s, proceed anyway (page may use unconventional structure)
4. Additional stability check: wait 500ms for final renders (SPA hydration, lazy loading)

### SPA Navigation

For returning to previous pages after interaction:
- Always use `page.goto(savedUrl)` instead of `page.goBack()` — SPAs with client-side routing may not support browser back correctly
- Save the current page URL before each element interaction
- After interaction + screenshot → navigate back to saved URL → wait for page ready

### Changed: Generic Modal/Drawer Detection

```
Current: MUI Dialog/Drawer classes
New:
- [role="dialog"], [role="alertdialog"]
- [aria-modal="true"]
- New element with high z-index + backdrop
- Class contains "modal", "drawer", "dialog", "popup"
```

### Changed: Generic Close Escalation Chain

1. Close button: `[aria-label*="close"]`, `[aria-label*="đóng"]`, `button:has-text("×")`, `button:has-text("Close")`, `.close`, `.modal-close`, `[data-dismiss="modal"]`
2. Cancel button: `button:has-text("Cancel")`, `button:has-text("Hủy")`, `button:has-text("Bỏ qua")` — note: Playwright's `has-text` does substring matching, so `"Hủy"` intentionally matches `"Hủy bỏ"` buttons in confirmation dialogs, which is the correct dismiss behavior
3. Escape key
4. Click backdrop: `.modal-backdrop`, `.overlay`, `[class*="backdrop"]`
5. Force navigate back (last resort)

---

## 7. AI Vision Integration (`ai-vision.ts`)

### Protocol: Exit-and-Resume with Session Persistence

Crawler does not call AI directly. It uses a structured exit protocol with browser session persistence:

```json
{
  "status": "needs_ai",
  "aiRequest": {
    "type": "login" | "navigation",
    "screenshot": "/path/to/screenshot.png",
    "prompt": "...",
    "context": {}
  },
  "sessionState": {
    "cookies": [...],
    "localStorage": {...},
    "currentUrl": "..."
  }
}
```

SKILL.md parses output → dispatches AI subagent → writes result + `sessionState` into input JSON → re-runs crawler.

### Session Persistence Between Passes

When the crawler exits with `needs_ai`, it saves browser session state:
1. Export cookies via `context.cookies()`
2. Export localStorage via `page.evaluate(() => JSON.stringify(localStorage))`
3. Save current URL

When the crawler resumes, it restores session state:
1. Set cookies via `context.addCookies(savedCookies)`
2. Navigate to `about:blank`
3. Restore localStorage via `page.evaluate()` (must happen before navigating to app URL — SPAs may read auth tokens from localStorage during page load)
4. Navigate to saved URL
5. Verify session is still valid (check if redirected to login)

This avoids redundant re-login between passes.

### Multi-Pass Execution Flow

```
Pass 1: crawler start → login heuristic fail → screenshot → save session → exit(needs_ai: login)
  SKILL.md: AI analyze login screenshot → return selectors
Pass 2: crawler resume → use AI selectors to login → nav heuristic fail → screenshot → save session → exit(needs_ai: navigation)
  SKILL.md: AI analyze nav screenshot → return nav type + region
Pass 3: crawler resume with session → scan menu → scan elements → output TestPlan
  SKILL.md: show test plan → user approve
Pass 4: crawler execute test plan → screenshots → output ExecutionResult
  SKILL.md: dispatch analyze subagents → report

Best case (heuristic login + heuristic nav both work): 2 passes (discovery + execution) — same as current
Typical case (heuristic login works, nav needs AI): 3 passes
Worst case (both need AI): 4 passes
```

### Error Handling for AI Responses

**Invalid selectors (login):**
1. AI returns selectors → crawler tries them → element not found or login fails
2. Crawler clears `cached.loginSelectors` → retries heuristic with broader selectors
3. If still fails → exit with error: "Could not login. Please provide login selectors manually in config."

**Wrong navigation type:**
1. AI says "top-navbar" but heuristic scan finds 0 menu items in that region
2. Crawler clears `cached.navType` → retries with AI, adding context: "Previous detection found 0 items. Re-analyze."
3. Max 2 AI retries for navigation → then fail with descriptive error

**AI subagent timeout/failure:**
1. SKILL.md sets 30s timeout per AI call
2. On timeout → retry once
3. On second failure → skip AI, fall back to broad heuristic scan (try all nav patterns)

**Cache invalidation:**
- If login with cached selectors fails → clear `cached.loginSelectors`, retry with fresh detection
- If nav scan with cached type finds 0 items → clear `cached.navType`, retry with fresh detection
- User can force full re-detect by deleting the `cached` object from config

### Caching

AI results are saved to `config.cached`. On subsequent runs:
- `cached.loginSelectors` exists → skip AI login detection, use cached selectors
- `cached.navType` + `cached.navRegion` exists → skip AI nav detection, use cached values

Cache is auto-invalidated when detection results fail at use time (see Error Handling above).

---

## 8. Config Changes

### Updated Config Schema

```json
{
  "baseUrl": "https://staging.example.com",
  "auth": {
    "loginPath": "/login",
    "username": "...",
    "password": "...",
    "postLoginPath": "/admin",
    "successUrlPattern": "**/admin**"
  },
  "viewport": { "width": 1920, "height": 1080 },
  "screenshotDir": "/tmp/visual-test-screenshots",
  "timeouts": {
    "navigation": 15000,
    "element": 5000,
    "retry": 10000
  },
  "limits": {
    "maxPages": 100,
    "maxDuration": 1800000,
    "maxElementsPerPage": 30
  },
  "cached": {
    "loginSelectors": null,
    "navType": null,
    "navRegion": null
  }
}
```

### Backward Compatibility

- All existing config fields are preserved
- `cached` is optional — missing means crawler will auto-detect
- Old langfarm configs will work without changes
- The existing `sidebar` config field (with `iconSelector`, `submenuContainerSelector`, etc.) is preserved as a **manual override**. If `sidebar` is present in config, navigator skips both heuristic and AI detection and uses the provided selectors directly. This ensures backward compatibility with existing langfarm config.

---

## 9. Analyze Prompt Changes

### Removed (MUI-specific)
- "MUI Outlined label notch rendering" references
- "MUI Dialog/Drawer" class references
- "MUI form controls" specific checks

### Replaced With (Generic)
- "Floating label rendering" — covers MUI, Ant Design, Bootstrap floating labels
- "Modal/dialog" — generic modal patterns
- "Form control consistency" — height, spacing, alignment across any framework

### Added
- Top navbar alignment checks
- Hamburger menu animation/transition checks
- Tab-based navigation state consistency checks

### Retained
- 5-pass scan structure (Structure → Boundary → Row-by-Row → Element → Interaction State)
- Severity levels (CRITICAL, WARNING, INFO)
- Output format
- All generic checks (overlap, containment, typography, spacing, badges, error exposure)

---

## 10. Migration Plan

1. Create `src/` directory with all new modules
2. Extract code from `crawler-script.ts` into modules — refactor, don't rewrite from scratch
3. Replace MUI-specific selectors with generic ones
4. Add AI exit-and-resume protocol to `ai-vision.ts`
5. Update `SKILL.md` to handle `needs_ai` responses and multi-pass execution
6. Update `analyze-prompt.md` to remove MUI references
7. Update `guide.md` and `README.md`
8. Delete `crawler-script.ts`
9. Test with langfarm (MUI) to verify backward compatibility
10. Test with a non-MUI app to verify generic support
