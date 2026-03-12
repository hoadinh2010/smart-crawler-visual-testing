# Smart Crawler Visual Testing

A [Claude Code](https://claude.ai/claude-code) skill that automatically crawls your web app's UI and uses AI vision to find layout bugs, overlapping components, spacing issues, and UX problems.

## How It Works

1. **Login** to your app — Claude auto-detects your login form on the first run
2. **Detect navigation** — AI identifies your nav type (sidebar, top navbar, hamburger, tabs) and crawls all pages via DFS
3. **Click every interactive element** — buttons, tabs, dropdowns, table rows, modals...
4. **Screenshot each state** — page load, modal open, tab switch, detail page...
5. **AI analyzes** every screenshot using a systematic 5-pass scan
6. **Report** bugs by severity: CRITICAL, WARNING, INFO

**Zero config.** Only needs `baseUrl` and login credentials.

## What It Detects

- Component overlap and z-index issues
- Layout breaks, grid misalignment
- Text truncation, "undefined"/"null"/"NaN" values
- Inconsistent spacing and orphaned elements
- Form control height/label rendering issues
- Content overflow, raw technical errors exposed to users
- Modal/drawer display issues
- Badge/tag semantic color mismatches
- And more — see [analyze-prompt.md](analyze-prompt.md) for the full checklist

## Supported Frameworks

Works with any UI framework — no framework-specific configuration needed:

- **Component libraries:** MUI (Material UI), Ant Design, Chakra UI
- **CSS frameworks:** Tailwind CSS, Bootstrap
- **Custom CSS:** Any in-house or custom design system

## Supported Navigation Types

- **Sidebar (left/right)** — standard vertical sidebar, including icon-only collapsible sidebars
- **Top navbar** — horizontal navigation bar at the top
- **Hamburger menu** — hidden/toggle menu for mobile or responsive layouts
- **Tabs** — horizontal or vertical tab-based navigation

## Installation

### Prerequisites

```bash
npm install -g tsx
npx playwright install chromium
```

### As a Claude Code Skill

Copy the skill files to your Claude Code skills directory:

```bash
# Clone this repo
git clone https://github.com/whammytech/smart-crawler-visual-testing.git

# Copy to Claude Code skills directory
cp -r smart-crawler-visual-testing ~/.claude/skills/visual-testing

# Install dependencies
cd ~/.claude/skills/visual-testing && npm install
```

## Usage

In Claude Code, just say:

```
visual test
```

### First Run

Claude will ask for your app's URL and login credentials, then automatically:
- Detect your login form
- Create a config file at `.claude/visual-test.config.json`
- Detect your navigation type and crawl all pages
- Show you a test plan for approval
- Run the full test suite
- Analyze screenshots and generate a report

### Subsequent Runs

Config is saved — just say `visual test` again.

## Skill Structure

```
SKILL.md              # Orchestrator — workflow definition
crawler-script.ts     # Playwright crawler (login detection, nav detection, element click, screenshot)
analyze-prompt.md     # AI analysis prompt (5-pass systematic scan)
guide.md              # Usage guide (Vietnamese)
package.json          # Dependencies
```

The crawler uses a single `crawler-script.ts` with detect modes — it automatically determines the navigation type at runtime rather than requiring manual configuration.

## Documentation

See [guide.md](guide.md) for detailed usage instructions (Vietnamese).

## License

MIT
