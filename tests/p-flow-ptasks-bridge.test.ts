import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, findSkills } from './helpers.js';

// ---------------------------------------------------------------------------
// p-flow ↔ p-tasks soft bridge invariants.
//
// The bridge lets p-flow OPTIONALLY mirror a task into p-tasks, but the two
// plugins must stay usable independently. This file defends three properties
// that keep that true:
//   1. independence — no manifest-level dependency on p-tasks;
//   2. decoupling   — no cross-plugin CLI call (never p-tasks' ptasks.mjs);
//   3. gating       — the bridge is always behind the marker-file check.
// ---------------------------------------------------------------------------

const pflowDir = join(repoRoot(), 'plugins', 'p-flow');
const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const BRIDGE_DOC = 'plugins/p-flow/skills/_shared/ptasks-bridge.md';
const HOST_SKILLS = [
  'plugins/p-flow/skills/writing-plan/SKILL.md',
  'plugins/p-flow/skills/task-end/SKILL.md',
];
const MARKER = 'docs/tasks/.ptasks.json';

describe('p-flow ↔ p-tasks bridge', () => {
  it('1. independence: p-flow plugin.json declares no plugin dependency', () => {
    const manifest = JSON.parse(
      read('plugins/p-flow/.claude-plugin/plugin.json'),
    ) as Record<string, unknown>;
    // The platform's `dependencies` field is hard/required — it would force
    // p-tasks to install/enable alongside p-flow, breaking standalone use.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.requires).toBeUndefined();
    expect(manifest.extends).toBeUndefined();
  });

  it('2. the bridge contract doc exists and pins gate + dispatch + inert-when-absent', () => {
    const doc = read(BRIDGE_DOC);
    expect(doc).toContain(MARKER);
    expect(doc).toContain('Skill tool');
    expect(doc).toContain('p-tasks:add');
    expect(doc).toContain('p-tasks:set');
    expect(doc).toContain('p-tasks:next');
    // `list` is the canonical whole-plan walk/enumeration command — guards
    // against a revert to `summary` (done only) or `next` (open only) when the
    // full step list with statuses is needed.
    expect(doc).toContain('p-tasks:list');
    // "Absent → silent no-op" — p-flow stays inert when p-tasks isn't present.
    expect(doc).toContain('Absent');
    expect(doc).toContain('silent');
  });

  it('3 & 5. gate: both host skills route through the bridge contract', () => {
    for (const rel of HOST_SKILLS) {
      expect(read(rel)).toContain('_shared/ptasks-bridge.md');
    }
  });

  it('canonical store: the bridge pins the "p-tasks is the single artifact, NO plan.md" rule', () => {
    const doc = read(BRIDGE_DOC);
    // p-tasks is the single source of truth for steps when present…
    expect(doc).toMatch(/single canonical store|canonical work-item store|owns WORK ITEMS/i);
    // …and in canonical mode there is NO plan.md at all.
    expect(doc).toMatch(/no .*plan\.md/i);
    // narrative lives in specification.md, not a plan.md.
    expect(doc).toContain('specification.md');
    // the review audit lives in p-tasks as done sub-tasks carrying a `resolution`.
    expect(doc).toContain('resolution');
  });

  it('canonical store: there is NO slim plan template — writing-plan writes no plan.md in canonical mode', () => {
    // The canonical-mode plan.md was eliminated; its template must be gone…
    const templatePath = join(
      repoRoot(),
      'plugins/p-flow/skills/_shared/templates/plan-tasks.template.md',
    );
    expect(existsSync(templatePath), 'plan-tasks.template.md must be deleted').toBe(false);
    // …and writing-plan must not reference it any more.
    const wp = read('plugins/p-flow/skills/writing-plan/SKILL.md');
    expect(wp).not.toContain('plan-tasks.template.md');
    // writing-plan must explicitly NOT write plan.md in canonical mode.
    expect(wp).toMatch(/do NOT write .*plan\.md/i);
  });

  it('4. decoupling: no p-flow skill calls p-tasks’ CLI directly', () => {
    // Every SKILL.md in p-flow, plus the shared bridge doc, must be free of the
    // p-tasks CLI entry — dispatch goes through the Skill tool, never a path
    // into p-tasks' own ${CLAUDE_PLUGIN_ROOT}.
    const sources = [
      ...findSkills(pflowDir).map((s) => ({ path: s.skillMdPath, text: s.raw })),
      { path: join(repoRoot(), BRIDGE_DOC), text: read(BRIDGE_DOC) },
    ];
    for (const { path, text } of sources) {
      expect(text, `${path} must not reference p-tasks' CLI`).not.toContain('ptasks.mjs');
    }
  });
});
