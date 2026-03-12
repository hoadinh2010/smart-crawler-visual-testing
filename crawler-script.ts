import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';

// --- Types ---

interface CrawlerConfig {
  baseUrl: string;
  auth: {
    loginPath: string;
    username: string;
    password: string;
    // Path to navigate to after login if app lands on an intermediate page (e.g. tenant selector)
    postLoginPath?: string;
    // URL pattern that indicates successful login (glob). Default: '**/admin**'
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
  // Optional sidebar config for apps with non-standard navigation (icon sidebar + submenu drawer)
  sidebar?: {
    iconSelector?: string;          // CSS selector for sidebar icon buttons that open submenus
    submenuContainerSelector?: string; // Selector for submenu container after clicking an icon
    submenuItemSelector?: string;    // Selector for individual submenu items
    submenuTitleSelector?: string;   // Selector for the submenu category title
  };
}

interface MenuItem {
  label: string;
  url: string | null;
  level: number;
  children: MenuItem[];
  selector: string;
}

type ElementType =
  | 'navigation'
  | 'action-open'
  | 'action-danger'
  | 'action-submit'
  | 'tab'
  | 'table-row'
  | 'dropdown'
  | 'external';

interface PageElement {
  selector: string;
  label: string;
  type: ElementType;
  action: 'click' | 'click+cancel' | 'click+close' | 'skip';
}

interface TestPlanPage {
  index: number;
  menuPath: string;
  url: string;
  source: 'menu' | 'table-row-detail';
  elements: PageElement[];
}

interface TestPlan {
  generatedAt: string;
  baseUrl: string;
  totalPages: number;
  totalElements: number;
  estimatedDuration: string;
  pages: TestPlanPage[];
  skippedExternal: number;
  skippedSubmit: number;
}

interface ScreenshotEntry {
  index: number;
  filename: string;
  menuPath: string;
  elementLabel: string | null;
  elementType: ElementType | 'page';
  url: string;
}

interface ExecutionResult {
  page: TestPlanPage;
  status: 'pass' | 'issues' | 'failed' | 'skipped';
  duration: number;
  elementsClicked: number;
  elementsFailed: number;
  screenshots: ScreenshotEntry[];
  errors: string[];
}

type LogLevel = 'info' | 'warn' | 'error';
type LogAction =
  | 'navigate' | 'page_load' | 'screenshot' | 'click'
  | 'close' | 'back' | 'timeout' | 'retry' | 'failed'
  | 'skip' | 'login' | 'discovery' | 'limit';

// --- Logger ---

class CrawlerLogger {
  private logFile: string;

  constructor(screenshotDir: string) {
    this.logFile = join(screenshotDir, 'crawler.log');
    // Clear previous log
    writeFileSync(this.logFile, '');
  }

  log(level: LogLevel, action: LogAction, details: Record<string, any>): void {
    const ts = new Date().toISOString();
    const time = ts.substring(11, 19); // HH:MM:SS

    // JSONL to file
    const jsonLine = JSON.stringify({ ts, level, action, ...details });
    appendFileSync(this.logFile, jsonLine + '\n');

    // Human-readable to stdout
    const icon = this.getIcon(action, level);
    const actionStr = action.toUpperCase().padEnd(12);
    const menuPath = details.menuPath || '';
    const extra = this.formatExtra(action, details);
    console.error(`[${time}] ${icon} ${actionStr} ${menuPath}${extra}`);
  }

  private getIcon(action: LogAction, level: LogLevel): string {
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

// --- Login ---

async function login(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<void> {
  const { baseUrl, auth, timeouts } = config;
  logger.log('info', 'login', { menuPath: 'Login', url: `${baseUrl}${auth.loginPath}` });

  await page.goto(`${baseUrl}${auth.loginPath}`);
  await page.waitForSelector('.MuiOutlinedInput-root input', { timeout: timeouts.navigation });

  const inputs = page.locator('.MuiOutlinedInput-root input');
  await inputs.first().fill(auth.username);
  await inputs.nth(1).fill(auth.password);
  await page.click('button[type="submit"]');

  const result = await Promise.race([
    page.waitForURL('**/master-menu**', { timeout: timeouts.navigation }).then(() => 'success' as const),
    page.waitForURL('**/admin**', { timeout: timeouts.navigation }).then(() => 'success' as const),
    page.waitForURL('**/forceChangePassword**', { timeout: timeouts.navigation }).then(() => 'forceChangePassword' as const),
    page.waitForSelector('.MuiAlert-root', { timeout: timeouts.navigation }).then(() => 'authError' as const),
  ]);

  if (result === 'authError') throw new Error('Login failed. Check credentials.');
  if (result === 'forceChangePassword') throw new Error('Test user requires password change.');

  // If postLoginPath is configured, navigate there (e.g. to get past a tenant selector page)
  if (auth.postLoginPath) {
    logger.log('info', 'login', { menuPath: 'Login', element: `Navigating to ${auth.postLoginPath}...` });
    await page.goto(`${baseUrl}${auth.postLoginPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: timeouts.navigation,
    });
    await page.waitForTimeout(2000);
  }

  logger.log('info', 'login', { menuPath: 'Login', duration: 0, element: 'Login successful' });
}

// --- Sidebar Scanner ---

// Strategy A: Icon sidebar with submenu drawer (SPA apps using onClick navigation)
// Detects sidebar icons, clicks each to open a submenu flyout, then clicks
// each submenu item to discover the URL it navigates to.
// Selectors can be overridden via config.sidebar.
async function scanIconSidebar(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger,
  sidebarConfig?: CrawlerConfig['sidebar']
): Promise<MenuItem[]> {
  const flatItems: MenuItem[] = [];

  // Use configured selectors or auto-detect common patterns
  const iconSel = sidebarConfig?.iconSelector
    || await autoDetectIconSelector(page);
  if (!iconSel) {
    logger.log('warn', 'discovery', {
      menuPath: 'Sidebar',
      error: 'Could not detect icon sidebar buttons',
    });
    return [];
  }

  const submenuItemSel = sidebarConfig?.submenuItemSelector
    || '.MuiListItem-root, .MuiListItemButton-root, [role="menuitem"], li[class*="menu"], li[class*="item"]';
  const submenuTitleSel = sidebarConfig?.submenuTitleSelector
    || 'h1, h2, h3, h4, h5, h6, [class*="title"], [class*="header"] span, [class*="header"] p';

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

      // Try to read category title from the flyout/drawer
      const categoryTitle = await page
        .locator(submenuTitleSel)
        .first()
        .textContent({ timeout: 2000 })
        .then((t) => t?.trim() || `Category ${i + 1}`)
        .catch(() => `Category ${i + 1}`);

      // Find submenu items in the most recently opened flyout/drawer
      const submenuItems = page.locator(submenuItemSel).filter({ hasText: /.+/ });
      const submenuCount = await submenuItems.count();

      logger.log('info', 'discovery', {
        menuPath: categoryTitle,
        element: `Found ${submenuCount} submenu items`,
      });

      for (let j = 0; j < submenuCount; j++) {
        const itemText = await submenuItems
          .nth(j)
          .textContent({ timeout: 2000 })
          .then((t) => t?.trim() || '')
          .catch(() => '');

        if (!itemText) continue;

        const urlBefore = page.url();
        try {
          await submenuItems.nth(j).click({ timeout: 3000 });
          await page.waitForFunction(
            (prevUrl: string) => window.location.href !== prevUrl,
            urlBefore,
            { timeout: 5000 }
          );
          await page.waitForTimeout(300);

          const newUrl = page.url();
          const pathname = new URL(newUrl).pathname;

          if (pathname === new URL(urlBefore).pathname) continue;

          const menuPath = `${categoryTitle} > ${itemText}`;
          flatItems.push({
            label: menuPath,
            url: pathname,
            level: 1,
            children: [],
            selector: `${submenuItemSel}:nth-child(${j + 1})`,
          });

          logger.log('info', 'discovery', { menuPath, url: pathname });

          // Navigate back and reopen the same category for next item
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
      logger.log('warn', 'failed', {
        menuPath: `Category ${i}`,
        error: err.message,
      });
    }
  }

  return flatItems;
}

// Auto-detect icon sidebar buttons by looking for common patterns
async function autoDetectIconSelector(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // Common patterns for icon-only sidebar buttons:
    // 1. ListItemButton with only an icon (no text) inside a narrow sidebar
    // 2. IconButton elements grouped in a vertical strip
    const candidates = [
      // MUI icon-only list items in a narrow container
      '.MuiListItem-root .MuiListItemButton-root:has(.MuiListItemIcon-root)',
      // Generic icon buttons in sidebar-like containers
      '[class*="sidebar"] .MuiIconButton-root',
      '[class*="sidebar"] .MuiListItemButton-root',
      '[class*="Sidebar"] .MuiListItemButton-root',
      // Narrow vertical strip with buttons
      '.MuiDrawer-root .MuiListItemButton-root',
    ];

    for (const sel of candidates) {
      const items = document.querySelectorAll(sel);
      // Need at least 3 icon buttons to consider it a sidebar
      if (items.length >= 3) {
        // Verify they're in a narrow container (icon sidebar is typically < 80px wide)
        const parent = items[0].closest('[class*="sidebar"], [class*="Sidebar"], .MuiDrawer-root, .MuiBox-root');
        if (parent) {
          const rect = parent.getBoundingClientRect();
          if (rect.width < 100) return sel;
        }
        // Even without narrow container check, if we have many icon buttons, use them
        if (items.length >= 4) return sel;
      }
    }
    return null;
  });
}

// Strategy B: Standard sidebar with <a> links in nav/drawer
async function scanStandardSidebar(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger
): Promise<MenuItem[]> {
  // Find the navigation container
  const navSelector = await page.evaluate(() => {
    const candidates = [
      '.MuiDrawer-root nav',
      '.MuiDrawer-root',
      'nav',
      'aside',
      '[role="navigation"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.querySelectorAll('a').length > 3) return sel;
    }
    return 'nav';
  });

  // Expand all collapsed menu groups
  const expandables = page.locator(`${navSelector} [aria-expanded="false"]`);
  const expandCount = await expandables.count();
  for (let i = 0; i < expandCount; i++) {
    try {
      await expandables.nth(i).click();
      await page.waitForTimeout(300);
    } catch {
      // Some may not be clickable
    }
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
        if (href.includes('logout') || href.includes('settings') || href === '#' || href === '') return;
        if (!label) return;

        let level = 0;
        let parent = anchor.parentElement;
        while (parent && parent !== nav) {
          if (parent.tagName === 'UL' || parent.tagName === 'OL' || parent.classList.contains('MuiList-root')) {
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
    flatItems.push({
      ...item,
      label: menuPath,
      children: [],
    });
    parentStack.push({ label: item.label, level: item.level });
  }

  return flatItems;
}

// Main scanner: detect sidebar type and use appropriate strategy
async function scanSidebar(
  page: Page,
  baseUrl: string,
  logger: CrawlerLogger,
  config?: CrawlerConfig
): Promise<MenuItem[]> {
  logger.log('info', 'discovery', { menuPath: 'Sidebar', element: 'Scanning menu items...' });

  // Detect sidebar type: icon sidebar with submenu drawer vs standard nav links
  const hasIconSidebar = config?.sidebar?.iconSelector
    || await autoDetectIconSelector(page) !== null;

  // Also check if standard nav has enough links
  const standardLinkCount = await page.evaluate(() => {
    const navCandidates = ['nav', '.MuiDrawer-root', 'aside', '[role="navigation"]'];
    for (const sel of navCandidates) {
      const el = document.querySelector(sel);
      if (el && el.querySelectorAll('a[href]').length > 3) return el.querySelectorAll('a[href]').length;
    }
    return 0;
  });

  let items: MenuItem[];
  if (standardLinkCount > 3) {
    logger.log('info', 'discovery', {
      menuPath: 'Sidebar',
      element: `Using standard nav link strategy (${standardLinkCount} links found)`,
    });
    items = await scanStandardSidebar(page, baseUrl, logger);
  } else if (hasIconSidebar) {
    logger.log('info', 'discovery', {
      menuPath: 'Sidebar',
      element: 'Detected icon sidebar — using icon+submenu strategy',
    });
    items = await scanIconSidebar(page, baseUrl, logger, config?.sidebar);
  } else {
    logger.log('warn', 'discovery', {
      menuPath: 'Sidebar',
      element: 'No sidebar detected — no menu items found',
    });
    items = [];
  }

  logger.log('info', 'discovery', {
    menuPath: 'Sidebar',
    element: `Found ${items.length} menu items`,
  });

  return items;
}

// --- Element Classifier ---

async function scanPageElements(
  page: Page,
  baseUrl: string,
  maxElements: number,
  logger: CrawlerLogger,
  menuPath: string
): Promise<PageElement[]> {
  const baseDomain = new URL(baseUrl).hostname;

  const rawElements = await page.evaluate(
    ({ domain, max }: { domain: string; max: number }) => {
      // Polyfill __name which esbuild/tsx injects but doesn't exist in browser context
      if (typeof (globalThis as any).__name === 'undefined') {
        (globalThis as any).__name = (fn: any) => fn;
      }

      const results: Array<{
        selector: string;
        label: string;
        tagName: string;
        href: string | null;
        type: string | null;
        ariaLabel: string | null;
        classList: string[];
        role: string | null;
      }> = [];

      // Skip elements inside nav/sidebar (already handled by menu scanner)
      // NOTE: Use var-assigned functions (not declarations) to avoid esbuild __name decorator
      // which breaks inside page.evaluate()
      var isInNav = function(el: Element): boolean {
        // Check the element itself first
        if (el.closest && el.closest('nav, [role="navigation"], .MuiDrawer-root, .MuiDrawer-paper, aside')) {
          return true;
        }
        // Also check if the element is a sidebar icon button (small fixed container on the left)
        var rect = el.getBoundingClientRect();
        if (rect.right < 80) return true; // Elements fully within leftmost 80px are likely sidebar icons
        // Fallback: walk up parents
        let parent = el.parentElement;
        while (parent) {
          if (
            parent.tagName === 'NAV' ||
            parent.tagName === 'ASIDE' ||
            parent.getAttribute('role') === 'navigation' ||
            parent.classList.contains('MuiDrawer-root') ||
            parent.classList.contains('MuiDrawer-paper')
          ) return true;
          parent = parent.parentElement;
        }
        return false;
      };

      // --- Robust selector builder ---
      var buildSelector = function(el: Element): string {
        // Priority 1: data-testid
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${testId}"]`;

        // Priority 2: unique aria-label
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          const sel = `${el.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        // Priority 3: button/a with unique text content
        const text = el.textContent?.trim() || '';
        if (text && text.length < 50 && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
          const tag = el.tagName.toLowerCase();
          const sel = `${tag}:text("${text}")`;
          // Playwright :text() pseudo-selector — works at click time
          return sel;
        }

        // Priority 4: unique class combination
        if (el.classList.length > 0) {
          const classSel = el.tagName.toLowerCase() + '.' + Array.from(el.classList).join('.');
          if (document.querySelectorAll(classSel).length === 1) return classSel;
        }

        // Priority 5: CSS path from parent with stable selector
        let path = el.tagName.toLowerCase();
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          const parentId = parent.getAttribute('id');
          if (parentId) {
            path = `#${parentId} > ${path}`;
            break;
          }
          const siblings = parent.children;
          const sameTag = Array.from(siblings).filter(s => s.tagName === el.tagName);
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(el) + 1;
            path = `${parent.tagName.toLowerCase()} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
          }
          parent = parent.parentElement;
        }
        return path;
      };

      // Collect buttons
      document.querySelectorAll('button, [role="button"]').forEach((el) => {
        if (isInNav(el)) return;
        if (!(el as HTMLElement).offsetParent) return; // Not visible
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        results.push({
          selector: buildSelector(el),
          label: el.textContent?.trim() || '',
          tagName: el.tagName.toLowerCase(),
          href: null,
          type: el.getAttribute('type'),
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList),
          role: el.getAttribute('role'),
        });
      });

      // Collect tabs
      document.querySelectorAll('[role="tab"], .MuiTab-root').forEach((el) => {
        if (isInNav(el)) return;
        if (!(el as HTMLElement).offsetParent) return;
        results.push({
          selector: buildSelector(el),
          label: el.textContent?.trim() || '',
          tagName: el.tagName.toLowerCase(),
          href: null,
          type: null,
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList),
          role: 'tab',
        });
      });

      // Collect first table row (clickable)
      const firstRow =
        document.querySelector('table tbody tr:first-child') ||
        document.querySelector('.MuiDataGrid-row:first-child');
      if (firstRow && (firstRow as HTMLElement).offsetParent) {
        results.push({
          selector: firstRow.matches('.MuiDataGrid-row')
            ? '.MuiDataGrid-row:first-child'
            : 'table tbody tr:first-child',
          label: 'row[0]',
          tagName: 'tr',
          href: null,
          type: null,
          ariaLabel: null,
          classList: [],
          role: 'row',
        });
      }

      // Collect dropdowns
      document.querySelectorAll('select, .MuiSelect-root, [role="combobox"]').forEach((el) => {
        if (isInNav(el)) return;
        if (!(el as HTMLElement).offsetParent) return;
        results.push({
          selector: buildSelector(el),
          label: el.textContent?.trim() || '',
          tagName: el.tagName.toLowerCase(),
          href: null,
          type: null,
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList),
          role: 'combobox',
        });
      });

      // Collect internal links (not in nav)
      document.querySelectorAll('main a[href], .MuiContainer-root a[href], [role="main"] a[href]').forEach((el) => {
        if (isInNav(el)) return;
        if (!(el as HTMLElement).offsetParent) return;
        const href = (el as HTMLAnchorElement).href;
        if (!href) return;

        results.push({
          selector: buildSelector(el),
          label: el.textContent?.trim() || '',
          tagName: 'a',
          href: (el as HTMLAnchorElement).getAttribute('href'),
          type: null,
          ariaLabel: el.getAttribute('aria-label'),
          classList: Array.from(el.classList),
          role: null,
        });
      });

      return results.slice(0, max);
    },
    { domain: baseDomain, max: maxElements }
  );

  // Classify each element
  const elements: PageElement[] = [];

  for (const raw of rawElements) {
    const text = (raw.label + ' ' + (raw.ariaLabel || '')).toLowerCase();
    const classStr = raw.classList.join(' ').toLowerCase();

    let type: ElementType;
    let action: PageElement['action'];

    // Classification priority order (per spec):
    // 1. action-submit (SKIP) — check first to never accidentally click submit/save
    // 2. action-danger — click + cancel
    // 3. action-open — click + close
    // 4. external links — skip
    // 5. structural types (tab, table-row, dropdown, navigation)
    // 6. catch-all → action-open

    if (raw.type === 'submit' || /\b(submit|save|lưu|xác nhận|gửi)\b/i.test(text)) {
      type = 'action-submit';
      action = 'skip';
    } else if (/\b(delete|remove|xóa|hủy bỏ)\b/i.test(text) || classStr.includes('containederror') || classStr.includes('color-error')) {
      type = 'action-danger';
      action = 'click+cancel';
    } else if (raw.role === 'tab') {
      type = 'tab';
      action = 'click';
    } else if (raw.role === 'row' || raw.selector.includes('tr:first-child') || raw.selector.includes('DataGrid-row')) {
      type = 'table-row';
      action = 'click';
    } else if (raw.role === 'combobox' || raw.tagName === 'select' || classStr.includes('muiselect')) {
      type = 'dropdown';
      action = 'click+close';
    } else if (raw.href) {
      // Link — check if external
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
      // Catch-all: unmatched buttons default to action-open
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

// --- Page Ready Detection ---

async function waitForPageReady(
  page: Page,
  timeout: number
): Promise<void> {
  const contentSelectors = [
    '.MuiContainer-root',
    '[role="main"]',
    'main',
    '.MuiBox-root',
  ];

  const selectorFound = await Promise.any(
    contentSelectors.map((sel) =>
      page.waitForSelector(sel, { state: 'visible', timeout }).then(() => true)
    )
  ).catch(() => false);

  if (!selectorFound) {
    await page.waitForTimeout(2000);
  }

  // Stability delay — let SPA transitions settle
  await page.waitForTimeout(500);
}

// --- Phase 1: Discovery ---

async function runDiscovery(
  page: Page,
  config: CrawlerConfig,
  menuItems: MenuItem[],
  logger: CrawlerLogger
): Promise<TestPlan> {
  const startTime = Date.now();
  const pages: TestPlanPage[] = [];
  let pageIndex = 0;
  let skippedExternal = 0;
  let skippedSubmit = 0;

  for (const item of menuItems) {
    if (pageIndex >= config.limits.maxPages) {
      logger.log('warn', 'limit', {
        menuPath: item.label,
        error: `maxPages limit (${config.limits.maxPages}) reached`,
      });
      break;
    }

    if (!item.url) continue;

    try {
      logger.log('info', 'navigate', { menuPath: item.label, url: item.url });
      await page.goto(`${config.baseUrl}${item.url}`, {
        timeout: config.timeouts.navigation,
        waitUntil: 'domcontentloaded',
      });
      await waitForPageReady(page, config.timeouts.navigation);

      const elements = await scanPageElements(
        page,
        config.baseUrl,
        config.limits.maxElementsPerPage,
        logger,
        item.label
      );

      skippedExternal += elements.filter((e) => e.type === 'external').length;
      skippedSubmit += elements.filter((e) => e.type === 'action-submit').length;

      pages.push({
        index: pageIndex,
        menuPath: item.label,
        url: item.url,
        source: 'menu',
        elements,
      });

      pageIndex++;
    } catch (err: any) {
      logger.log('error', 'failed', {
        menuPath: item.label,
        error: err.message,
      });
    }
  }

  const totalElements = pages.reduce((sum, p) => sum + p.elements.length, 0);
  const clickableElements = pages.reduce(
    (sum, p) => sum + p.elements.filter((e) => e.action !== 'skip').length,
    0
  );
  const discoveryTime = Date.now() - startTime;
  const estimatedExecution = clickableElements * 3000; // ~3s per click avg
  const totalEstimate = discoveryTime + estimatedExecution;

  const plan: TestPlan = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    totalPages: pages.length,
    totalElements,
    estimatedDuration: `~${Math.ceil(totalEstimate / 60000)} minutes (${Math.ceil(discoveryTime / 1000)}s discovery + ~${Math.ceil(estimatedExecution / 60000)} min execution)`,
    pages,
    skippedExternal,
    skippedSubmit,
  };

  return plan;
}

function formatTestPlan(plan: TestPlan): string {
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
  return Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
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

// --- Screenshot Helper ---

interface ExecutionState {
  screenshotCounter: number;
}

function toKebab(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

async function takeScreenshot(
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

  return {
    index,
    filename,
    menuPath,
    elementLabel,
    elementType,
    url,
  };
}

// --- Modal/Drawer Close ---

async function closeModalOrDrawer(
  page: Page,
  pageUrl: string,
  isDanger: boolean,
  logger: CrawlerLogger,
  menuPath: string
): Promise<void> {
  // For danger dialogs, specifically look for Cancel
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
    } catch {
      // Fall through to generic close
    }
  }

  // Try close buttons
  const closeSelectors = [
    '[aria-label="close"]',
    '[aria-label="Close"]',
    '.MuiDialog-root button:has(.MuiSvgIcon-root):first-child',
    '.MuiModal-root button:has(.MuiSvgIcon-root)',
    'button:text("Cancel")',
    'button:text("Hủy")',
    'button:text("Đóng")',
    'button:text("Close")',
  ];

  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        logger.log('info', 'close', { menuPath, element: `Closed via ${sel}` });
        await page.waitForTimeout(500);

        // Verify closed
        const stillOpen = await page.locator('.MuiModal-root, .MuiDialog-root, .MuiDrawer-root .MuiDrawer-paper').first().isVisible().catch(() => false);
        if (!stillOpen) return;
      }
    } catch {
      continue;
    }
  }

  // Try Escape key
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const stillOpen = await page.locator('.MuiModal-root, .MuiDialog-root').first().isVisible().catch(() => false);
  if (!stillOpen) {
    logger.log('info', 'close', { menuPath, element: 'Closed via Escape' });
    return;
  }

  // Force navigate back
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

  logger.log('info', 'click', {
    menuPath,
    element: element.label,
    type: element.type,
  });

  try {
    const locator = page.locator(element.selector).first();
    await locator.scrollIntoViewIfNeeded({ timeout: timeouts.element });

    switch (element.type) {
      case 'tab': {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(500);
        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, element.label, 'tab', currentUrl, logger, state
        );
        return shot;
      }

      case 'dropdown': {
        await locator.click({ timeout: timeouts.element });
        await page.waitForTimeout(500);
        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, element.label, 'dropdown', currentUrl, logger, state
        );
        // Close dropdown by clicking away
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        return shot;
      }

      case 'table-row': {
        // Check for clickable link in first row first
        const rowLink = page.locator('table tbody tr:first-child a[href], .MuiDataGrid-row:first-child a[href]').first();
        const hasLink = await rowLink.isVisible().catch(() => false);

        if (hasLink) {
          await rowLink.click({ timeout: timeouts.element });
        } else {
          await locator.click({ timeout: timeouts.element });
        }

        await waitForPageReady(page, timeouts.navigation);
        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, 'row0-detail', 'table-row', page.url(), logger, state
        );

        // Go back to list
        logger.log('info', 'back', { menuPath });
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        await waitForPageReady(page, timeouts.navigation);
        return shot;
      }

      case 'navigation': {
        await locator.click({ timeout: timeouts.element });
        await waitForPageReady(page, timeouts.navigation);
        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, element.label, 'navigation', page.url(), logger, state
        );

        // Go back
        logger.log('info', 'back', { menuPath });
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
        await waitForPageReady(page, timeouts.navigation);
        return shot;
      }

      case 'action-danger': {
        await locator.click({ timeout: timeouts.element });
        // Wait for confirm dialog
        await page.waitForTimeout(1000);
        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, element.label, 'action-danger', currentUrl, logger, state
        );
        // MUST cancel
        await closeModalOrDrawer(page, currentUrl, true, logger, menuPath);
        return shot;
      }

      case 'action-open':
      default: {
        await locator.click({ timeout: timeouts.element });
        // Wait for modal/drawer to appear
        await page.waitForTimeout(1000);

        // Check if a modal/drawer opened
        const modalVisible = await page
          .locator('.MuiModal-root, .MuiDialog-root, .MuiDrawer-root .MuiDrawer-paper, [role="dialog"]')
          .first()
          .isVisible()
          .catch(() => false);

        const shot = await takeScreenshot(
          page, screenshotDir, menuPath, element.label, 'action-open', currentUrl, logger, state
        );

        if (modalVisible) {
          await closeModalOrDrawer(page, currentUrl, false, logger, menuPath);
        }

        return shot;
      }
    }
  } catch (err: any) {
    logger.log('warn', 'timeout', {
      menuPath,
      element: element.label,
      type: element.type,
      error: err.message,
    });
    return null; // Caller handles retry
  }
}

// --- Session Re-login ---

async function checkAndRelogin(
  page: Page,
  config: CrawlerConfig,
  logger: CrawlerLogger
): Promise<void> {
  const currentUrl = page.url();
  if (currentUrl.includes(config.auth.loginPath) || currentUrl.includes('/login')) {
    logger.log('warn', 'login', { menuPath: 'Session', error: 'Session expired, re-logging in...' });
    await login(page, config, logger);
  }
}

// --- Phase 2: Execution ---

async function runExecution(
  page: Page,
  config: CrawlerConfig,
  plan: TestPlan,
  logger: CrawlerLogger
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  const startTime = Date.now();
  const state: ExecutionState = { screenshotCounter: 0 };

  for (const planPage of plan.pages) {
    // Check duration limit
    if (Date.now() - startTime > config.limits.maxDuration) {
      logger.log('warn', 'limit', {
        menuPath: planPage.menuPath,
        error: `maxDuration limit (${config.limits.maxDuration / 60000} min) reached`,
      });
      break;
    }

    const pageStartTime = Date.now();
    const pageResult: ExecutionResult = {
      page: planPage,
      status: 'pass',
      duration: 0,
      elementsClicked: 0,
      elementsFailed: 0,
      screenshots: [],
      errors: [],
    };

    try {
      // Navigate to page
      logger.log('info', 'navigate', { menuPath: planPage.menuPath, url: planPage.url });
      await page.goto(`${config.baseUrl}${planPage.url}`, {
        timeout: config.timeouts.navigation,
        waitUntil: 'domcontentloaded',
      });
      await waitForPageReady(page, config.timeouts.navigation);

      // Check if session expired (redirected to login)
      await checkAndRelogin(page, config, logger);

      const loadTime = Date.now() - pageStartTime;
      logger.log('info', 'page_load', { menuPath: planPage.menuPath, duration: loadTime });

      // Screenshot the page itself
      const pageShot = await takeScreenshot(
        page, config.screenshotDir, planPage.menuPath, null, 'page', planPage.url, logger, state
      );
      pageResult.screenshots.push(pageShot);

      const currentUrl = `${config.baseUrl}${planPage.url}`;

      // Click each element
      for (const element of planPage.elements) {
        if (element.action === 'skip') continue;

        let shot = await interactWithElement(
          page, element, config, planPage.menuPath, currentUrl, logger, state
        );

        // Retry once on failure
        if (!shot) {
          logger.log('info', 'retry', {
            menuPath: planPage.menuPath,
            element: element.label,
            type: element.type,
          });

          // Reload page and retry
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
            await waitForPageReady(page, config.timeouts.navigation);
            shot = await interactWithElement(
              page, element, config, planPage.menuPath, currentUrl, logger, state
            );
          } catch {
            // Retry also failed
          }

          if (!shot) {
            logger.log('error', 'failed', {
              menuPath: planPage.menuPath,
              element: element.label,
              error: 'Failed after retry',
            });
            pageResult.elementsFailed++;
            pageResult.errors.push(`${element.label} [${element.type}]: failed after retry`);
            continue;
          }
        }

        pageResult.elementsClicked++;
        pageResult.screenshots.push(shot);
      }
    } catch (err: any) {
      logger.log('error', 'failed', {
        menuPath: planPage.menuPath,
        error: err.message,
      });
      pageResult.status = 'failed';
      pageResult.errors.push(`Page load: ${err.message}`);

      // Retry page once
      try {
        logger.log('info', 'retry', { menuPath: planPage.menuPath, element: 'page load' });
        await page.goto(`${config.baseUrl}${planPage.url}`, {
          timeout: config.timeouts.retry,
          waitUntil: 'domcontentloaded',
        });
        await waitForPageReady(page, config.timeouts.retry);
        pageResult.status = 'pass';
      } catch {
        logger.log('error', 'failed', {
          menuPath: planPage.menuPath,
          error: 'Page load failed after retry, skipping',
        });
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

// --- Main ---

interface CliInput {
  mode: 'discover' | 'execute';
  config: CrawlerConfig;
  testPlan?: TestPlan; // Required for 'execute' mode
}

async function main(): Promise<void> {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: npx tsx crawler-script.ts <input-file.json>');
    process.exit(1);
  }

  const rawInput = readFileSync(inputArg, 'utf-8');
  const input: CliInput = JSON.parse(rawInput);

  mkdirSync(input.config.screenshotDir, { recursive: true });
  const logger = new CrawlerLogger(input.config.screenshotDir);

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: input.config.viewport,
  });
  const page: Page = await context.newPage();

  try {
    await login(page, input.config, logger);

    if (input.mode === 'discover') {
      // Phase 1: Discovery
      const menuItems = await scanSidebar(page, input.config.baseUrl, logger, input.config);
      const testPlan = await runDiscovery(page, input.config, menuItems, logger);

      // Output test plan as JSON (for SKILL.md to parse)
      console.log(JSON.stringify(testPlan, null, 2));
    } else if (input.mode === 'execute') {
      if (!input.testPlan) throw new Error('testPlan required for execute mode');

      // Phase 2: Execution
      const results = await runExecution(page, input.config, input.testPlan, logger);

      // Count total screenshots from results
      const totalScreenshots = results.reduce((sum, r) => sum + r.screenshots.length, 0);

      // Output execution results as JSON
      const output = {
        results,
        totalScreenshots,
        logFile: join(input.config.screenshotDir, 'crawler.log'),
      };
      console.log(JSON.stringify(output, null, 2));
    }
  } catch (err: any) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
