# p-flow Wave B — discovery skill + session-start hook

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make p-flow discoverable in every Claude Code session by shipping (a) a `using-p-flow` discovery skill and (b) a SessionStart hook that surfaces it as a `<system-reminder>` whenever a session starts, clears, or compacts. Closes audit gaps B1 (session-start hook) and A-11 (using-p-flow meta skill).

**Spec reference:**
- `plugins/p-flow/docs/specs/2026-05-27-superpowers-parity.md` — Dim B (architectural) §B2 + Dim A row 11 + Dim D-6 (`<EXTREMELY-IMPORTANT>` adoption on discovery skill).
- `plugins/p-flow/docs/plans/2026-05-27-superpowers-parity-remediation.md` — Wave B outline.

**Reference implementation:**
- `superpowers/skills/using-superpowers/SKILL.md` — proven pattern; we mirror the shape but stay leaner.
- `superpowers/hooks/hooks.json` + `hooks/session-start` + `hooks/run-hook.cmd` — proven hook wiring; we copy structure with p-flow-specific content.

**Out of scope:**
- Multi-host context files (`AGENTS.md`, `GEMINI.md`, `gemini-extension.json`) — per audit B3/B4, perky.team is Claude-Code-only.
- `<EXTREMELY-IMPORTANT>` adoption on non-discovery skills — only `using-p-flow` carries it.
- Adoption of superpowers' multi-page meta-philosophy (red flags, skill priority table, skill types) — we ship a leaner discovery doc focused on listing p-flow skills + when to invoke each.

---

## Design decisions baked in

| Decision | Choice | Rationale |
|---|---|---|
| **Length of `using-p-flow` body** | **Lean** (~1.5–2k chars) — list the 7 skills, when to invoke, hard rule about user precedence, that's it | superpowers' 7k+-char preamble is general-framework scope; p-flow is one workflow. Long preamble bloats every session context. |
| **Hook scripts shipped** | **Both** `session-start` (bash, Unix/macOS/Git Bash) and `run-hook.cmd` (Windows native cmd) | Mirrors superpowers; covers all CC platforms. The `.cmd` is a thin shim that calls bash if available, else does direct emission. |
| **Hook content** | **Inline full SKILL.md body** in the system-reminder (same as superpowers) | The skill body IS the discovery payload; pointing at the file forces Claude to Read it separately = extra round-trip. |
| **Hook matcher** | `startup\|clear\|compact` (verbatim from superpowers) | Tested-and-true. Fires on fresh session, `/clear`, and after auto-compaction. |
| **plugin.json hooks declaration** | **None — rely on auto-discovery of `hooks/hooks.json`** | superpowers' plugin.json doesn't declare hooks; Claude Code finds the file by convention. |
| **`<EXTREMELY-IMPORTANT>` + `<SUBAGENT-STOP>` tags** | **Both present** in the discovery skill body (mirror superpowers' tags verbatim) | These XML tags are part of the proven discovery pattern; their function is enforced via the system-reminder framing. |

If you disagree with any of these — say so before Task 1 starts.

---

## File map

| File | Action | Task |
|---|---|---|
| `plugins/p-flow/skills/using-p-flow/SKILL.md` | create | 1 |
| `plugins/p-flow/hooks/hooks.json` | create | 2 |
| `plugins/p-flow/hooks/session-start` | create (bash, executable) | 3 |
| `plugins/p-flow/hooks/run-hook.cmd` | create (Windows shim) | 3 |
| `plugins/p-flow/README.md` | modify (add Discovery section) | 4 |
| `plugins/p-flow/.claude-plugin/plugin.json` | modify (description: mention discovery skill; bump version) | 5 (in release) |
| `.claude-plugin/marketplace.json` | modify (mirror description bump) | 5 (in release) |
| (verification — manual smoke) | run | 6 |
| (commit, tag, push) | release | 7 |

---

## Task 1: Author `skills/using-p-flow/SKILL.md`

**Files:**
- Create: `plugins/p-flow/skills/using-p-flow/SKILL.md`

- [ ] **Step 1: Create dir + write skill**

```bash
mkdir -p plugins/p-flow/skills/using-p-flow
```

The skill body (target ≤ 2000 chars body, excluding frontmatter):

````markdown
---
name: using-p-flow
description: Use when starting any conversation in a repo with p-flow enabled — establishes the p-flow task development flow surface (commands, skills, when to invoke each) so the model can pick the right tool without keyword guessing.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If a p-flow skill clearly applies to what the user is asking (task setup, planning, verification, review, finishing), you MUST invoke it via the Skill tool before any other action.

User instructions (CLAUDE.md, AGENTS.md, direct request) ALWAYS take precedence over this skill. The user is in control.
</EXTREMELY-IMPORTANT>

# Using p-flow

p-flow ships a disciplined task development flow for Claude Code: brainstorm → plan → verify → review → push.

## Slash commands (user-triggered)

| Command | When user types it |
|---|---|
| `/p-flow:init` | Bootstrap p-flow rules + templates + secret-deny-list into the current repo. One-time per repo. |
| `/p-flow:task-start <slug> [--worktree]` | Open a new task. Creates `<type>/<slug>` branch + `specs/<slug>/` dir + invokes brainstorming. |
| `/p-flow:task-end` | Finalize the task: pre-checks, push, recommend MR/PR. |

## Skills (model-invoked when context applies)

| Skill | Invoke when |
|---|---|
| `task-brainstorming` | User starts a new non-trivial task — auto-invoked by `task-start`, can also be called directly. |
| `writing-plan` | After a spec exists at `specs/<slug>/specification.md`. |
| `verification-before-completion` | Before ANY claim of "done", "fixed", "ready", or before any `git commit`. Non-negotiable. |
| `requesting-code-review` | After verification passes and there's a diff worth reviewing. Dispatches code-review subagent via inline template. |
| `requesting-task-review` | Same trigger; orthogonal lens — checks spec/plan alignment instead of code quality. |

## Hard rules

- **Verification is non-negotiable.** Never claim work is done without running `verification-before-completion`.
- **Reviews are read-only.** `requesting-*-review` skills dispatch reviewers that NEVER edit files; their output goes into `plan.md` as follow-ups.
- **plan.md sections are canonical.** `## Steps`, `## Review follow-ups — <date>`, `## Review decisions (audit)`, `## Open questions`, `## Risks` — don't rename, don't reorder.
- **Slug resolution.** Branches follow `<type>/<slug>` for `<type> ∈ {feature, bugfix, hotfix, chore, docs}`. Skills resolve `<slug>` from the branch name; if branch doesn't match, ask the user.

## Where to look for more

- Plugin README: `plugins/p-flow/README.md`
- Per-skill spec: `plugins/p-flow/skills/<name>/SKILL.md`
- Design history: `plugins/p-flow/docs/`
````

(Confirm the body is ≤ 2000 chars after the closing tag.)

- [ ] **Step 2: Validate frontmatter + body length**

Run:
```bash
head -5 plugins/p-flow/skills/using-p-flow/SKILL.md
wc -c plugins/p-flow/skills/using-p-flow/SKILL.md
```
Expected: valid `---/name/description/---` frontmatter; total file ≤ ~2.5 KB.

- [ ] **Step 3: Run skills.test.ts**

```bash
npm test -- tests/skills.test.ts
```
Expected: green; +7 new tests for using-p-flow (auto-discovered).

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/skills/using-p-flow/SKILL.md
git commit -m "feat(p-flow): add using-p-flow discovery skill"
```

---

## Task 2: Author `hooks/hooks.json`

**Files:**
- Create: `plugins/p-flow/hooks/hooks.json`

- [ ] **Step 1: Create dir + write hooks.json**

```bash
mkdir -p plugins/p-flow/hooks
```

Content (verbatim from superpowers, with the only change being the script name remains `session-start`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "async": false
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('plugins/p-flow/hooks/hooks.json', 'utf-8'))"
```
Expected: no output (no parse error).

- [ ] **Step 3: Commit (defer until Task 3 — hooks.json without scripts is broken)**

Hold; commit together with Task 3.

---

## Task 3: Author hook scripts (`session-start` + `run-hook.cmd`)

**Files:**
- Create: `plugins/p-flow/hooks/session-start` (bash, executable)
- Create: `plugins/p-flow/hooks/run-hook.cmd` (Windows shim)

- [ ] **Step 1: Author `hooks/session-start` (bash)**

Adapt superpowers' script. The script's job: read `using-p-flow/SKILL.md`, JSON-escape it, emit a `<system-reminder>` JSON envelope to stdout so Claude Code injects it into the next prompt.

Skeleton:

```bash
#!/usr/bin/env bash
# SessionStart hook for p-flow plugin
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

using_p_flow_content=$(cat "${PLUGIN_ROOT}/skills/using-p-flow/SKILL.md" 2>&1 || echo "Error reading using-p-flow skill")

# JSON-escape: backslash, quote, newline, CR, tab. Bash parameter substitution
# (single-pass per character class) — orders of magnitude faster than a
# character-by-character loop.
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

escaped_content=$(escape_for_json "$using_p_flow_content")

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "<system-reminder>\nSessionStart hook additional context: <EXTREMELY_IMPORTANT>\nYou have superpowers.\n\n**Below is the full content of your 'p-flow:using-p-flow' skill - your introduction to p-flow's task development flow:**\n\n---\n${escaped_content}\n---\n</EXTREMELY_IMPORTANT>\n</system-reminder>"
  }
}
EOF
```

Make it executable:
```bash
chmod +x plugins/p-flow/hooks/session-start
```

- [ ] **Step 2: Author `hooks/run-hook.cmd` (Windows shim)**

Adapt superpowers' .cmd. On Windows, Claude Code spawns hooks via cmd; the .cmd locates Git-Bash and runs the bash script. Skeleton:

```cmd
@echo off
setlocal

REM run-hook.cmd <hook-name>
REM Locate Git-Bash and run the matching bash script.

set HOOK_NAME=%~1
set SCRIPT_DIR=%~dp0

REM Try common Git-Bash locations
set BASH_EXE=
if exist "C:\Program Files\Git\bin\bash.exe" set BASH_EXE=C:\Program Files\Git\bin\bash.exe
if "%BASH_EXE%"=="" if exist "C:\Program Files (x86)\Git\bin\bash.exe" set BASH_EXE=C:\Program Files (x86)\Git\bin\bash.exe
if "%BASH_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe

if "%BASH_EXE%"=="" (
  echo {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<system-reminder>p-flow hook: Git-Bash not found on PATH. Skipping discovery skill injection.</system-reminder>"}}
  exit /b 0
)

"%BASH_EXE%" "%SCRIPT_DIR%%HOOK_NAME%"
exit /b %ERRORLEVEL%
```

Verify the actual layout of superpowers' run-hook.cmd before finalizing (cat the original; copy the proven shape; only change the JSON fallback message).

- [ ] **Step 3: Smoke-invoke the bash script**

```bash
bash plugins/p-flow/hooks/session-start | head -20
```
Expected: valid JSON output containing `"hookEventName": "SessionStart"` and the using-p-flow content embedded.

If output is invalid JSON, fix the escape function before committing.

- [ ] **Step 4: Commit hooks.json + scripts together**

```bash
git add plugins/p-flow/hooks/
git commit -m "feat(p-flow): add SessionStart hook that surfaces using-p-flow on session start/clear/compact"
```

---

## Task 4: Document the discovery + hook in plugin README

**Files:**
- Modify: `plugins/p-flow/README.md`

- [ ] **Step 1: Add a `## Discovery` section between "Commands" and "Reviewer templates"**

Content:

```markdown
## Discovery

p-flow ships a `SessionStart` hook (`hooks/hooks.json`) that surfaces the `using-p-flow` skill as a `<system-reminder>` whenever a Claude Code session starts, after `/clear`, and after auto-compaction. This is how Claude finds p-flow's surface without keyword guessing.

To disable: remove or comment out the hook entry in `hooks/hooks.json` (per-plugin opt-out), or globally remove the plugin.
```

- [ ] **Step 2: Add `using-p-flow` to the Skills table**

The current `## Skills (invoked by commands or context)` table needs a new row at the top:

```markdown
| `using-p-flow` | Auto-emitted by the SessionStart hook on every fresh session / `/clear` / auto-compact. Establishes the p-flow surface for the model. |
```

- [ ] **Step 3: Validate**

```bash
npm test -- tests/plugin-readme-coverage.test.ts
```
Expected: green; `using-p-flow` now mentioned in README.

- [ ] **Step 4: Commit**

```bash
git add plugins/p-flow/README.md
git commit -m "docs(p-flow): document discovery skill + SessionStart hook"
```

---

## Task 5: Update plugin metadata + bump version

**Files:**
- Modify: `plugins/p-flow/.claude-plugin/plugin.json` (description + version)
- Modify: `.claude-plugin/marketplace.json` (description)

- [ ] **Step 1: Add `using-p-flow` to the Skills list in both descriptions**

Append `, using-p-flow` to the Skills enumeration. Add a phrase like "Discoverable via SessionStart hook." at the end of each description.

- [ ] **Step 2: Bump p-flow version**

`plugin.json` `version`: `0.3.0` → `0.4.0` (minor — new skill + new hook; backwards-compatible).

- [ ] **Step 3: Validate**

```bash
npm run validate
```
Expected: ✓ all manifests pass.

- [ ] **Step 4: Commit — held until release (Task 7)**

This commit lands as the release commit.

---

## Task 6: Smoke-verify the hook end-to-end

**Files:** none modified.

- [ ] **Step 1: Direct hook invocation**

```bash
bash plugins/p-flow/hooks/session-start | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const j=JSON.parse(d); console.log('event:', j.hookSpecificOutput.hookEventName); console.log('reminder length:', j.hookSpecificOutput.additionalContext.length, 'chars'); console.log('contains using-p-flow:', j.hookSpecificOutput.additionalContext.includes('using-p-flow'));})"
```

Expected:
- `event: SessionStart`
- `reminder length: ~2000-3000 chars`
- `contains using-p-flow: true`

If any line fails, debug the hook script.

- [ ] **Step 2: Windows shim sanity (if on Windows)**

```cmd
plugins\p-flow\hooks\run-hook.cmd session-start
```
Expected: same JSON output as Step 1.

- [ ] **Step 3: Live verification deferred to next CC session**

The hook fires only on `SessionStart`/`/clear`/`/compact`. To confirm it works live in Claude Code:

1. Push + tag the release (Task 7).
2. Reinstall (or update) p-flow in your active Claude Code installation.
3. Open a new session — you should see a `<system-reminder>` injected at the top containing the using-p-flow body.
4. If not seen — check Claude Code logs for hook-execution errors.

Document this manual verification step in the release notes (Task 7).

---

## Task 7: Release

**Files:** none modified (version bump from Task 5 lands here as the release commit).

- [ ] **Step 1: Final validate + tests**

```bash
npm run validate && npm test 2>&1 | tail -3
```
Expected: all green; test count increased by ~7 (using-p-flow's auto-coverage in skills.test.ts + plugin-readme-coverage.test.ts).

- [ ] **Step 2: Propose to user**

> *"Proposed: **v4.8.0** (minor — adds using-p-flow discovery skill + SessionStart hook; p-flow `0.3.0` → `0.4.0`). Backwards-compatible. Manual verification step: open a new CC session after install to confirm the hook fires. Confirm to proceed."*

Wait for explicit confirmation.

- [ ] **Step 3: After confirmation — release**

```bash
git add plugins/p-flow/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(release): v4.8.0 — p-flow Wave B: discovery skill + SessionStart hook

Bump p-flow to 0.4.0. Adds using-p-flow skill that's surfaced via a
SessionStart hook on every fresh session / clear / compact. Closes
audit gaps B2 (session-start hook) and A-11 (using-p-flow discovery
skill).

Manual verification: open a new Claude Code session after installing/
updating the plugin. A <system-reminder> with the using-p-flow body
should appear at session start."
git push origin main
git tag v4.8.0
git push origin v4.8.0
```

---

## Self-review checklist

- [ ] using-p-flow body ≤ ~2 KB and lists all 7 (now 8 incl. self) skills.
- [ ] `<EXTREMELY-IMPORTANT>` + `<SUBAGENT-STOP>` tags present, exactly mirroring superpowers' usage.
- [ ] hooks.json parses; matcher = `startup|clear|compact`.
- [ ] session-start (bash) emits valid JSON containing the SKILL.md body.
- [ ] run-hook.cmd locates Git-Bash and falls back to a no-op JSON if not found.
- [ ] Plugin README has a `## Discovery` section + using-p-flow in Skills table.
- [ ] plugin.json + marketplace.json mention using-p-flow + hook.
- [ ] `v4.8.0` tag created only after explicit user confirmation (per CLAUDE.md rule).

## What this Wave deliberately does NOT do

- **Does not change any existing skill's body.** using-p-flow is additive.
- **Does not modify the hooks.json matcher** beyond `startup|clear|compact`. We don't fire on `PreCompact`, `PostToolUse`, etc.
- **Does not ship multi-host hint files** (AGENTS.md / GEMINI.md / gemini-extension.json) — per audit B3/B4, Claude-Code-only.
- **Does not write tests for the hook script behaviour** — JSON shape is validated manually + the hook is small (<50 lines). Worth revisiting in Wave D cleanup if drift surfaces.
- **Does not preempt user's CLAUDE.md / AGENTS.md** — using-p-flow explicitly says user instructions take precedence.
