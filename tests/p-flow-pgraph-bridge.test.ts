import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, findSkills } from './helpers.js';

// ---------------------------------------------------------------------------
// p-flow ↔ p-graph soft bridge invariants.
//
// p-graph differs from p-tasks/p-wiki: it exposes NO query skill (structural
// queries are CLI commands) and ships its own repo rule on init. So the bridge
// is advisory — it nudges writing-plan to use the graph and defers the actual
// commands to the installed `.claude/rules/p-graph.md`. This file defends:
//   1. independence — no manifest-level dependency on p-graph;
//   2. decoupling   — no cross-plugin CLI call (never p-graph's pgraph.mjs);
//   3. gating       — the bridge is behind the marker-file check;
//   4. deferral     — the bridge defers queries to the installed p-graph rule
//                     rather than duplicating p-graph's (pre-1.0) command table.
// ---------------------------------------------------------------------------

const pflowDir = join(repoRoot(), 'plugins', 'p-flow');
const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const BRIDGE_DOC = 'plugins/p-flow/skills/_shared/pgraph-bridge.md';
const HOST_SKILLS = ['plugins/p-flow/skills/writing-plan/SKILL.md'];
const MARKER = '.pgraph/config.json';

describe('p-flow ↔ p-graph bridge', () => {
  it('1. independence: p-flow plugin.json declares no plugin dependency', () => {
    const manifest = JSON.parse(
      read('plugins/p-flow/.claude-plugin/plugin.json'),
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.requires).toBeUndefined();
    expect(manifest.extends).toBeUndefined();
  });

  it('2. the bridge contract doc exists and pins gate + sync-dispatch + inert-when-absent', () => {
    const doc = read(BRIDGE_DOC);
    expect(doc).toContain(MARKER);
    // The only Skill-tool dispatch the bridge uses is the graph refresh.
    expect(doc).toContain('p-graph:sync');
    // "Absent → silent no-op" — p-flow stays inert when p-graph isn't present.
    expect(doc).toContain('Absent');
    expect(doc).toContain('say nothing');
  });

  it('3. gate: the host skill routes through the bridge contract', () => {
    for (const rel of HOST_SKILLS) {
      expect(read(rel)).toContain('_shared/pgraph-bridge.md');
    }
  });

  it('4. decoupling: no p-flow skill calls p-graph’s CLI directly', () => {
    const sources = [
      ...findSkills(pflowDir).map((s) => ({ path: s.skillMdPath, text: s.raw })),
      { path: join(repoRoot(), BRIDGE_DOC), text: read(BRIDGE_DOC) },
    ];
    for (const { path, text } of sources) {
      expect(text, `${path} must not reference p-graph's CLI`).not.toContain('pgraph.mjs');
    }
  });

  it('5. deferral: the bridge defers queries to the installed p-graph rule', () => {
    const doc = read(BRIDGE_DOC);
    // The bridge must point at the repo rule rather than hardcode p-graph's
    // command table — so p-graph can change its CLI without breaking p-flow.
    expect(doc).toContain('.claude/rules/p-graph.md');
  });
});
