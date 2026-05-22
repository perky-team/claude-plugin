# p-statusline Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `p-statusline`, a fourth plugin in the `perky.team` marketplace that packages the author's custom Claude Code status line for installation by other people.

**Architecture:** The status line is a standalone Node.js script (`statusline.js`), ported verbatim from the author's existing bash-wrapped `node -e` one-liner. A skill, `/p-statusline:init`, copies the script to a stable user-owned path (`~/.claude/p-statusline/`) and writes a `statusLine` block into the user's `~/.claude/settings.json` — a plugin cannot set the main status line directly. Two new Vitest files cover the script and the install algorithm; the repo's existing static tests pick the plugin up automatically.

**Tech Stack:** Node.js (built-in modules only — `fs`, `os`, `child_process`), Vitest + TypeScript for tests, JSON manifests, Markdown SKILL.md.

**Spec:** `docs/superpowers/specs/2026-05-22-p-statusline-plugin-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `plugins/p-statusline/statusline/statusline.js` | The status line renderer. Reads session JSON on stdin, prints a two-line ANSI status line. Created by porting the existing script. |
| `plugins/p-statusline/skills/init/SKILL.md` | The `/p-statusline:init` installer — copy script + merge `settings.json`. |
| `plugins/p-statusline/.claude-plugin/plugin.json` | Plugin manifest (name, version, description, author). |
| `plugins/p-statusline/README.md` | Per-plugin docs: install, segment reference, removal. |
| `.claude-plugin/marketplace.json` | Marketplace catalog — gains a fourth entry. |
| `README.md` (repo root) | Plugins table — gains a `p-statusline` row. |
| `tests/p-statusline-statusline.test.ts` | Spawns `statusline.js` with fixture stdin, asserts output per segment. |
| `tests/p-statusline-init-e2e.test.ts` | Re-implements the `init` algorithm against a temp HOME — executable spec. |

**Task ordering rationale:** the repo's `findPlugins()` helper skips any directory under `plugins/` that lacks `.claude-plugin/plugin.json`. So Tasks 1–2 can create the script, skill, and tests without the plugin becoming visible to `plugin-manifests.test.ts` / `skills.test.ts` / `marketplace.test.ts`. Task 3 adds the manifest + marketplace entry + READMEs in one commit, at which point the plugin becomes visible and complete. `npm test` stays green after every commit.

---

## Task 1: Port the status line script

**Files:**
- Create: `plugins/p-statusline/statusline/statusline.js`
- Test: `tests/p-statusline-statusline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/p-statusline-statusline.test.ts` with this exact content:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'plugins', 'p-statusline', 'statusline', 'statusline.js');

// Run statusline.js with `input` piped to stdin; return stdout.
function run(input: object): string {
  return execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
}

// Strip ANSI colour escapes so assertions read against plain text.
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const tempDirs: string[] = [];

// A throwaway directory that is NOT a git repository.
function makeNonGitDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'p-sl-plain-'));
  tempDirs.push(d);
  return d;
}

// A throwaway git repository with one commit on branch `work`.
function makeGitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'p-sl-git-'));
  tempDirs.push(d);
  const g = (args: string[]) => execFileSync('git', args, { cwd: d, stdio: 'ignore' });
  g(['init', '-b', 'work']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  writeFileSync(join(d, 'file.txt'), 'hello');
  g(['add', '.']);
  g(['commit', '-m', 'initial']);
  return d;
}

let nonGit: string;
beforeAll(() => { nonGit = makeNonGitDir(); });
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

describe('p-statusline statusline.js', () => {
  it('renders context %, token count, and cache % from context_window', () => {
    const out = plain(run({
      context_window: { used_percentage: 8, context_window_size: 200000, total_input_tokens: 80000 },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('8%');
    expect(out).toContain('80k');
  });

  it('falls back to "n/a" when rate_limits is absent', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out).toContain('5hn/a');
    expect(out).toContain('7dn/a');
  });

  it('renders rate-limit percentages when rate_limits is present', () => {
    const now = Math.floor(Date.now() / 1000);
    const out = plain(run({
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: now + 3600 },
        seven_day: { used_percentage: 5, resets_at: now + 6 * 86400 },
      },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toMatch(/5h20%/);
    expect(out).toMatch(/7d5%/);
  });

  it('omits the git segment when cwd is not a git repository', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out).not.toContain('⎇'); // ⎇ git glyph
  });

  it('shows the "0/0" task default when no transcript is provided', () => {
    const out = plain(run({ workspace: { current_dir: nonGit, project_dir: nonGit } }));
    expect(out).toContain('▸ 0/0'); // ▸ 0/0
  });

  it('renders model, effort, and a RAM percentage', () => {
    const out = plain(run({
      model: { display_name: 'Opus 4.7' },
      effort: { level: 'high' },
      workspace: { current_dir: nonGit, project_dir: nonGit },
    }));
    expect(out).toContain('Opus 4.7');
    expect(out).toContain('high');
    expect(out).toMatch(/RAM \d{1,3}%/);
  });

  it('shows the branch name when cwd is a git repository', () => {
    const repo = makeGitRepo();
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toContain('work');
  });

  it('shows the short commit hash on a detached HEAD', () => {
    const repo = makeGitRepo();
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    execFileSync('git', ['checkout', '--detach'], { cwd: repo, stdio: 'ignore' });
    const out = plain(run({ workspace: { current_dir: repo, project_dir: repo } }));
    expect(out).toContain(hash);
  });

  it('produces output without throwing on an empty input object', () => {
    const out = run({});
    expect(typeof out).toBe('string');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/p-statusline-statusline.test.ts`
Expected: FAIL — every test errors because `plugins/p-statusline/statusline/statusline.js` does not exist (`Cannot find module ...statusline.js`).

- [ ] **Step 3: Port the script**

The author's status line lives at `C:/Users/suhar/.claude/statusline-command.sh`. That file is a bash wrapper whose entire body is `exec node -e '<JavaScript>'`:

```
#!/usr/bin/env bash
exec node -e '
<JavaScript body — starts with `const { execSync } = require("child_process");`, ends with `});`>
'
```

Read `C:/Users/suhar/.claude/statusline-command.sh`. Create `plugins/p-statusline/statusline/statusline.js` containing **only the JavaScript body** — every line from `const { execSync } = require("child_process");` through the final `});`, inclusive, **byte-for-byte**. Do **not** include:
- the `#!/usr/bin/env bash` shebang line,
- the `exec node -e '` line,
- the closing `'` line.

Make no other change — the logic, segments, colours, and `try/catch` degradation are ported verbatim. The body uses only double-quoted and backtick strings (no single quotes), so it transfers cleanly into a `.js` file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/p-statusline-statusline.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-statusline/statusline/statusline.js tests/p-statusline-statusline.test.ts
git commit -m "feat(p-statusline): port status line script to standalone Node.js" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 6: Confirm the full suite is still green**

Run: `npm test`
Expected: PASS — the new file passes; existing tests are unaffected (`plugins/p-statusline/` has no `.claude-plugin/plugin.json` yet, so `findPlugins()` skips it).

---

## Task 2: Create the `init` skill and its E2E test

**Files:**
- Create: `plugins/p-statusline/skills/init/SKILL.md`
- Test: `tests/p-statusline-init-e2e.test.ts`

This task depends on Task 1: the E2E test copies the real `plugins/p-statusline/statusline/statusline.js`.

- [ ] **Step 1: Write the `init` skill**

Create `plugins/p-statusline/skills/init/SKILL.md` with this exact content:

````markdown
---
name: init
description: Install the p-statusline status line into Claude Code. Copies statusline.js to a stable path and writes the statusLine block into the user's ~/.claude/settings.json. Use when the user says "init p-statusline", "install statusline", or "set up the status line".
argument-hint: (no arguments)
allowed-tools: Bash(echo:*) Bash(node:*) Bash(mkdir:*) Bash(cp:*) Read Write
---

# /p-statusline:init

You are installing the `p-statusline` status line for the current user. This
writes to the **user-level** `~/.claude/settings.json`, not a project file —
a status line is a personal, global setting.

## Step 1 — Resolve the home directory

Run `echo "$HOME"` via Bash. Trim the result; call it `<home>`. If it is
empty, stop and tell the user you could not determine their home directory.

## Step 2 — Resolve the Node.js binary

Run `node -e "console.log(process.execPath)"` via Bash.

- If it succeeds, trim the output — call it `<node>` (an absolute path to the
  `node` binary, e.g. `C:\Program Files\nodejs\node.exe`).
- If it fails (Node is not on `PATH`), set `<node>` to the literal string
  `node` and warn the user: "Node.js was not found on PATH — the status line
  will only work if `node` is on PATH when Claude Code runs." Continue anyway.

## Step 3 — Copy the script to a stable path

The plugin's install directory moves on every update, so the script must live
somewhere stable and user-owned.

1. Create the target directory: `mkdir -p "<home>/.claude/p-statusline"`.
2. Copy the script:
   `cp "${CLAUDE_PLUGIN_ROOT}/statusline/statusline.js" "<home>/.claude/p-statusline/statusline.js"`.

If the copy fails because the source is missing, stop and tell the user the
plugin install may be corrupted. If it fails for any other reason, stop and
show the exact shell error.

Call the destination `<script>` = `<home>/.claude/p-statusline/statusline.js`.

## Step 4 — Read the settings file

Read `<home>/.claude/settings.json`.

- **Missing** → treat the settings as an empty object `{}`; you will create
  the file in Step 6.
- **Present but not valid JSON** → stop with: "Cannot proceed:
  `<home>/.claude/settings.json` is not valid JSON. Fix it manually and
  re-run `/p-statusline:init`."
- **Present but the parsed root is not a JSON object** (e.g. an array) → stop
  with: "Cannot proceed: `<home>/.claude/settings.json` root is not an
  object. Fix it manually and re-run `/p-statusline:init`."

## Step 5 — Protect an existing status line

Build the target command string (both paths quoted — they may contain spaces):

```
"<node>" "<script>"
```

Inspect the existing `statusLine` key:

- **Absent** → nothing to protect; continue.
- **Present and its `command` already contains `p-statusline/statusline.js`
  or `p-statusline\statusline.js`** → p-statusline is already installed. Tell
  the user so. Continue (Step 6 still refreshes the command, which corrects a
  moved home or a changed Node path).
- **Present and pointing somewhere else** → save the existing value verbatim
  to `<home>/.claude/p-statusline/statusline.prev.json` (pretty-printed JSON,
  2-space indent, trailing newline). Warn the user that their previous status
  line was replaced, and tell them where the backup is.

## Step 6 — Write the settings file

Set the `statusLine` key to:

```json
{ "type": "command", "command": "<target command from Step 5>" }
```

Leave every other key in the settings object untouched. Write the whole
object back to `<home>/.claude/settings.json` with 2-space indentation and a
trailing newline. If the file did not exist, create it now with just the
`statusLine` key.

## Step 7 — Final message

Tell the user, in this order:

1. The script was installed at `<home>/.claude/p-statusline/statusline.js`.
2. Whether `settings.json` was created fresh or updated in place.
3. If a previous status line was backed up, where the backup is.
4. They must **restart Claude Code** for the status line to appear.
5. To update later (after a plugin update) or to repair the config, just run
   `/p-statusline:init` again.

## Edge cases

- `~/.claude/settings.json` is invalid JSON → stop (Step 4).
- The settings root is not an object → stop (Step 4).
- `statusline.js` source is unreadable → stop, "plugin install may be
  corrupted" (Step 3).
- Node is not on `PATH` → continue with the bare string `node`, warn
  (Step 2).
- `mkdir` or a write fails (permissions) → stop, show the exact shell error.
- Re-run after a plugin update → Step 3 overwrites the copy with the new
  version, Step 5 reports "already installed", the command is refreshed.
  Safe and idempotent.
````

- [ ] **Step 2: Write the E2E test**

This test re-implements the `init` algorithm and runs it against a temp HOME — an executable spec, in the style of `tests/p-flow-init-e2e.test.ts`. Create `tests/p-statusline-init-e2e.test.ts` with this exact content:

```typescript
// E2E for p-statusline's /p-statusline:init.
//
// p-statusline has no CLI binary — the init flow is documented in
// `plugins/p-statusline/skills/init/SKILL.md` and executed by Claude itself
// (via Bash + Read + Write). This test programmatically re-implements that
// algorithm against a real temp filesystem and asserts on the result. It is
// an executable spec: if SKILL.md changes, this test should change with it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(__dirname, '..', 'plugins', 'p-statusline');
// SKILL.md Step 2 resolves the node binary; the test fixes it to the runner's.
const NODE = process.execPath;

interface InitResult {
  created: boolean;
  backedUp: boolean;
  alreadyInstalled: boolean;
}

// Re-implementation of SKILL.md Steps 3-6 (Steps 1-2, 7 are environment /
// messaging and not exercised here).
function runInit(home: string): InitResult {
  const claudeDir = join(home, '.claude');
  const targetDir = join(claudeDir, 'p-statusline');
  const script = join(targetDir, 'statusline.js');
  const settingsPath = join(claudeDir, 'settings.json');

  // Step 3 — copy the script to the stable path.
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(PLUGIN_ROOT, 'statusline', 'statusline.js'), script);

  // Step 4 — read settings.json.
  let settings: Record<string, unknown>;
  let created = false;
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      throw new Error('settings.json is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json root is not an object');
    }
    settings = parsed as Record<string, unknown>;
  } else {
    settings = {};
    created = true;
  }

  // Step 5 — protect an existing status line.
  const command = `"${NODE}" "${script}"`;
  let backedUp = false;
  let alreadyInstalled = false;
  const existing = settings.statusLine as { command?: unknown } | undefined;
  if (existing && typeof existing === 'object' && typeof existing.command === 'string') {
    const cmd = existing.command;
    if (cmd.includes('p-statusline/statusline.js') || cmd.includes('p-statusline\\statusline.js')) {
      alreadyInstalled = true;
    } else {
      writeFileSync(
        join(targetDir, 'statusline.prev.json'),
        JSON.stringify(existing, null, 2) + '\n',
        'utf-8',
      );
      backedUp = true;
    }
  }

  // Step 6 — write settings.json.
  settings.statusLine = { type: 'command', command };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  return { created, backedUp, alreadyInstalled };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'p-statusline-init-e2e-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('p-statusline init E2E', () => {
  it('creates settings.json with only statusLine when none exists', () => {
    const r = runInit(home);
    expect(r.created).toBe(true);
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(Object.keys(s)).toEqual(['statusLine']);
    expect(s.statusLine.type).toBe('command');
    expect(s.statusLine.command).toContain('statusline.js');
  });

  it('copies statusline.js into ~/.claude/p-statusline/', () => {
    runInit(home);
    expect(existsSync(join(home, '.claude', 'p-statusline', 'statusline.js'))).toBe(true);
  });

  it('preserves unrelated keys in an existing settings.json', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', theme: 'dark-ansi' }, null, 2),
      'utf-8',
    );
    runInit(home);
    const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(s.model).toBe('opus');
    expect(s.theme).toBe('dark-ansi');
    expect(s.statusLine.command).toContain('statusline.js');
  });

  it('backs up a foreign statusLine before replacing it', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const foreign = { type: 'command', command: 'bash /some/other/script.sh' };
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: foreign }, null, 2),
      'utf-8',
    );
    const r = runInit(home);
    expect(r.backedUp).toBe(true);
    const prev = JSON.parse(
      readFileSync(join(home, '.claude', 'p-statusline', 'statusline.prev.json'), 'utf-8'),
    );
    expect(prev).toEqual(foreign);
  });

  it('is idempotent when already pointing at our script', () => {
    runInit(home);
    const r = runInit(home);
    expect(r.alreadyInstalled).toBe(true);
    expect(existsSync(join(home, '.claude', 'p-statusline', 'statusline.prev.json'))).toBe(false);
  });

  it('rejects a settings.json that is not valid JSON', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{not json', 'utf-8');
    expect(() => runInit(home)).toThrow(/not valid JSON/);
  });

  it('rejects a settings.json whose root is not an object', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '["array"]', 'utf-8');
    expect(() => runInit(home)).toThrow(/not an object/);
  });
});
```

- [ ] **Step 3: Run the E2E test**

Run: `npx vitest run tests/p-statusline-init-e2e.test.ts`
Expected: PASS — all 7 tests green. (This test is self-contained — it exercises its own re-implementation of the algorithm, so it passes as soon as it is written, given Task 1's `statusline.js` exists.)

- [ ] **Step 4: Verify the SKILL.md and the E2E test agree**

Re-read `plugins/p-statusline/skills/init/SKILL.md` Steps 3–6 against the `runInit()` function. Confirm they describe the same behaviour: copy to the stable path, read+validate settings, the same target-command shape, the same idempotency marker (`p-statusline/statusline.js`), the same backup file (`statusline.prev.json`). Fix SKILL.md if they drift.

- [ ] **Step 5: Commit**

```bash
git add plugins/p-statusline/skills/init/SKILL.md tests/p-statusline-init-e2e.test.ts
git commit -m "feat(p-statusline): add init skill and E2E coverage" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 6: Confirm the full suite is still green**

Run: `npm test`
Expected: PASS — both new files pass; existing tests are unaffected (still no `plugin.json`, so `findPlugins()` skips the directory).

---

## Task 3: Add the manifest, marketplace entry, and READMEs

**Files:**
- Create: `plugins/p-statusline/.claude-plugin/plugin.json`
- Create: `plugins/p-statusline/README.md`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `README.md` (repo root)

This commit makes the plugin visible to `findPlugins()` and `marketplace.test.ts`. All four files must land together so the suite stays green.

- [ ] **Step 1: Create the plugin manifest**

Create `plugins/p-statusline/.claude-plugin/plugin.json` with this exact content:

```json
{
  "name": "p-statusline",
  "version": "0.1.0",
  "description": "Custom Claude Code status line: context %, rate limits with reset countdowns, git, task progress, model/effort, RAM. Skills: init.",
  "author": {
    "name": "Andrey Sukharev",
    "email": "andrey.sukharev@exinity.com"
  }
}
```

- [ ] **Step 2: Create the plugin README**

Create `plugins/p-statusline/README.md` with this exact content:

````markdown
# p-statusline

A custom status line for Claude Code — the two-line bar at the bottom of the
terminal. At a glance it shows:

**Line 1**
- **Context window** — usage percentage, token count, and cache-hit %. The %
  and token count share a green → red ramp that warms as the window fills.
- **Rate limits** — the 5-hour and 7-day usage windows, each with a countdown
  to reset. `n/a` until Claude Code reports the data.
- **Git** — branch name, `*` for uncommitted changes, a `wt:` marker inside a
  linked worktree, and `↑/↓` commits ahead of / behind upstream.
- **Task progress** — `▸ done/total` from the most recent TodoWrite, plus the
  in-progress task name.

**Line 2**
- Model and effort level.
- System RAM usage.
- The project directory.

## Requirements

Node.js — no extra install. Claude Code already runs on Node, and the script
uses only Node built-in modules.

## Install

1. Add this marketplace and install the plugin:

   ```text
   /plugin marketplace add perky-team/claude-plugin
   /plugin install p-statusline@perky.team
   ```

2. Activate the status line:

   ```text
   /p-statusline:init
   ```

   This copies the status line script to `~/.claude/p-statusline/` and adds a
   `statusLine` entry to `~/.claude/settings.json`. If you already had a
   status line configured, its previous value is saved to
   `~/.claude/p-statusline/statusline.prev.json`.

3. Restart Claude Code. The status line appears at the bottom of the terminal.

## Updating

After the plugin updates, run `/p-statusline:init` again to copy the newer
script into place.

## Removing

1. Delete the `statusLine` key from `~/.claude/settings.json` (or restore the
   value saved in `~/.claude/p-statusline/statusline.prev.json`).
2. Delete the `~/.claude/p-statusline/` directory.
3. Restart Claude Code.
````

- [ ] **Step 3: Add the marketplace entry**

Edit `.claude-plugin/marketplace.json`. The `plugins` array currently ends with the `p-tasks` entry. Add a fourth entry after it (insert a comma after the `p-tasks` object's closing `}`):

```json
    {
      "name": "p-statusline",
      "source": "./plugins/p-statusline",
      "description": "Custom Claude Code status line (context, rate limits, git, tasks, RAM). Skills: init."
    }
```

The resulting `plugins` array has four entries: `p-wiki`, `p-flow`, `p-tasks`, `p-statusline`.

- [ ] **Step 4: Add the root README row**

Edit `README.md` (repo root). In the `## Plugins` table, add this row immediately after the `p-tasks` row:

```markdown
| [`p-statusline`](./plugins/p-statusline/) | Custom Claude Code status line — context %, rate limits with reset countdowns, git, task progress, model/effort, RAM. Skills: `init`. |
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npm test`
Expected: PASS. The plugin is now visible to the static suite and must satisfy:
- `plugin-manifests.test.ts` — name `p-statusline` matches the directory, is kebab-case, version `0.1.0` is valid semver, README exists and is > 50 chars.
- `skills.test.ts` — the plugin has the `init` skill; its frontmatter `name` is `init`, `description` is > 30 chars, body is > 100 chars.
- `marketplace.test.ts` — the entry name matches `plugin.json`, `source` resolves to a directory containing `.claude-plugin/plugin.json`, no duplicate names, and the root README plugins table mentions `p-statusline`.
- `templates.test.ts` — no-op (the plugin has no `skills/_shared/templates/`).
- The two new test files still pass.

If any test fails, fix the offending file and re-run before committing.

- [ ] **Step 6: Commit**

```bash
git add plugins/p-statusline/.claude-plugin/plugin.json plugins/p-statusline/README.md .claude-plugin/marketplace.json README.md
git commit -m "feat(p-statusline): add plugin manifest, marketplace entry, and READMEs" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 7: Optional — validate with the Claude CLI**

If the `claude` CLI is on PATH, run: `npm run validate`
Expected: the validator accepts the marketplace and all four plugins. (Skip if the CLI is unavailable — `npm test` is the authoritative gate.)

---

## Done — and what is deliberately not here

After Task 3, `p-statusline` is a complete, installed-and-tested plugin in the marketplace. Out of scope by design (see the spec): segment toggles / user configuration, a SessionStart auto-refresh hook, a `remove` skill, and project-scope installation.

**Pushing and release tagging** is a separate, user-triggered step. Per `.claude/CLAUDE.md`, adding a new plugin is a **minor** version bump: bump `plugins/p-wiki/.claude-plugin/plugin.json#version`, state the proposed version to the user, and on confirmation `git tag` + `git push --tags`. Do not push or tag as part of executing this plan unless the user asks.
