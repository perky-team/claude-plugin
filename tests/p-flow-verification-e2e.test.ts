// E2E for p-flow's verification-before-completion skill.
//
// Like p-flow-init-e2e.test.ts: the skill has no CLI binary — the logic is
// documented in plugins/p-flow/skills/verification-before-completion/SKILL.md
// and executed by Claude itself. This test re-implements the marker-write +
// .gitignore-append rules from §5–§7 of that SKILL.md against a real temp
// filesystem, and asserts on the outcomes. It's an executable spec: if
// SKILL.md changes, this test must change with it (they're not otherwise
// coupled).
//
// Always runs in `npm test` (no external dependencies).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Result = 'pass' | 'fail' | 'no-tests';
type Outcome = { wroteMarker: boolean; markerPath?: string; gitignoreUpdated: boolean };

function branchSafe(branch: string): string {
  return branch.replaceAll('/', '__');
}

// Re-implementation of verification-before-completion's marker logic
// (§5 special cases, §6 marker write, §7 .gitignore append).
function applyVerification(
  repoRoot: string,
  branch: string,
  result: Result,
  testCommand?: string,
): Outcome {
  // §5: marker is written only when at least one verification command
  // actually ran and returned exit code 0.
  if (result !== 'pass') return { wroteMarker: false, gitignoreUpdated: false };

  // §6: write the marker.
  const safe = branchSafe(branch);
  const markerDir = join(repoRoot, '.claude', '.p-flow-state', safe);
  const markerPath = join(markerDir, 'last-verification');
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    markerPath,
    `timestamp: ${new Date().toISOString()}\ncommands:\n  - ${testCommand} (exit 0)\n`,
  );

  // §7: update .gitignore once.
  const gitignorePath = join(repoRoot, '.gitignore');
  const line = '.claude/.p-flow-state/';
  let updated = false;
  if (existsSync(gitignorePath)) {
    const cur = readFileSync(gitignorePath, 'utf-8');
    if (!cur.split('\n').some((l) => l.trim() === line)) {
      writeFileSync(
        gitignorePath,
        cur + (cur.endsWith('\n') ? '' : '\n') + '# p-flow session state\n' + line + '\n',
      );
      updated = true;
    }
  } else {
    writeFileSync(gitignorePath, '# p-flow session state\n' + line + '\n');
    updated = true;
  }

  return { wroteMarker: true, markerPath, gitignoreUpdated: updated };
}

describe('p-flow verification-before-completion (e2e)', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'p-flow-verif-'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes marker and creates .gitignore on pass when no .gitignore exists', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    expect(r.wroteMarker).toBe(true);
    expect(existsSync(r.markerPath!)).toBe(true);
    expect(r.markerPath).toContain(
      join('.claude', '.p-flow-state', 'feature__foo', 'last-verification'),
    );
    const gi = readFileSync(join(sandbox, '.gitignore'), 'utf-8');
    expect(gi).toContain('.claude/.p-flow-state/');
    expect(gi).toContain('# p-flow session state');
  });

  it('appends to existing .gitignore exactly once on pass', () => {
    writeFileSync(join(sandbox, '.gitignore'), 'node_modules/\n');
    applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    applyVerification(sandbox, 'feature/foo', 'pass', 'npm test');
    const gi = readFileSync(join(sandbox, '.gitignore'), 'utf-8');
    const occurrences = gi.split('\n').filter((l) => l.trim() === '.claude/.p-flow-state/').length;
    expect(occurrences).toBe(1);
    expect(gi).toContain('node_modules/');
  });

  it('does NOT write marker or touch .gitignore on test failure', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'fail');
    expect(r.wroteMarker).toBe(false);
    expect(existsSync(join(sandbox, '.claude', '.p-flow-state'))).toBe(false);
    expect(existsSync(join(sandbox, '.gitignore'))).toBe(false);
  });

  it('does NOT write marker or touch .gitignore when no tests detected', () => {
    const r = applyVerification(sandbox, 'feature/foo', 'no-tests');
    expect(r.wroteMarker).toBe(false);
    expect(existsSync(join(sandbox, '.claude', '.p-flow-state'))).toBe(false);
    expect(existsSync(join(sandbox, '.gitignore'))).toBe(false);
  });

  it('substitutes / → __ in branch name for the marker path', () => {
    const r = applyVerification(sandbox, 'bugfix/abc/123', 'pass', 'npm test');
    expect(r.markerPath).toContain(
      join('.claude', '.p-flow-state', 'bugfix__abc__123', 'last-verification'),
    );
  });
});
