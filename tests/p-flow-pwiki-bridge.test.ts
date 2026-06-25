import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, findSkills } from './helpers.js';

// ---------------------------------------------------------------------------
// p-flow ↔ p-wiki soft bridge invariants.
//
// The bridge lets p-flow OPTIONALLY consult and feed the p-wiki knowledge
// base, but the two plugins must stay usable independently. This file defends
// the same properties as the p-tasks bridge:
//   1. independence — no manifest-level dependency on p-wiki;
//   2. decoupling   — no cross-plugin CLI call (never p-wiki's pwiki.mjs);
//   3. gating       — the bridge is always behind the marker-file check;
//   4. capture path — capture goes through `compile`, never `ingest`
//                     (ingest refuses in-repo paths by design).
// ---------------------------------------------------------------------------

const pflowDir = join(repoRoot(), 'plugins', 'p-flow');
const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const BRIDGE_DOC = 'plugins/p-flow/skills/_shared/pwiki-bridge.md';
const HOST_SKILLS = [
  'plugins/p-flow/skills/task-brainstorming/SKILL.md',
  'plugins/p-flow/skills/task-end/SKILL.md',
];
const MARKER = 'docs/wiki/.pwiki.json';

describe('p-flow ↔ p-wiki bridge', () => {
  it('1. independence: p-flow plugin.json declares no plugin dependency', () => {
    const manifest = JSON.parse(
      read('plugins/p-flow/.claude-plugin/plugin.json'),
    ) as Record<string, unknown>;
    // The platform's `dependencies` field is hard/required — it would force
    // p-wiki to install/enable alongside p-flow, breaking standalone use.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.requires).toBeUndefined();
    expect(manifest.extends).toBeUndefined();
  });

  it('2. the bridge contract doc exists and pins gate + dispatch + inert-when-absent', () => {
    const doc = read(BRIDGE_DOC);
    expect(doc).toContain(MARKER);
    expect(doc).toContain('Skill tool');
    expect(doc).toContain('p-wiki:query');
    expect(doc).toContain('p-wiki:compile');
    // "Absent → silent no-op" — p-flow stays inert when p-wiki isn't present.
    expect(doc).toContain('Absent');
    expect(doc).toContain('silent');
  });

  it('3. gate: both host skills route through the bridge contract', () => {
    for (const rel of HOST_SKILLS) {
      expect(read(rel)).toContain('_shared/pwiki-bridge.md');
    }
  });

  it('4. decoupling: no p-flow skill calls p-wiki’s CLI directly', () => {
    // Every SKILL.md in p-flow, plus the shared bridge doc, must be free of the
    // p-wiki CLI entry — dispatch goes through the Skill tool, never a path
    // into p-wiki's own ${CLAUDE_PLUGIN_ROOT}.
    const sources = [
      ...findSkills(pflowDir).map((s) => ({ path: s.skillMdPath, text: s.raw })),
      { path: join(repoRoot(), BRIDGE_DOC), text: read(BRIDGE_DOC) },
    ];
    for (const { path, text } of sources) {
      expect(text, `${path} must not reference p-wiki's CLI`).not.toContain('pwiki.mjs');
    }
  });

  it('5. capture path: the bridge captures via compile, not ingest', () => {
    const doc = read(BRIDGE_DOC);
    // p-flow artifacts live in-repo; ingest refuses in-repo paths and redirects
    // to compile. The doc must spell out the compile-not-ingest rule so a future
    // edit can't silently switch to the path p-wiki rejects.
    expect(doc).toContain('compile');
    expect(doc).toMatch(/never\s+`?ingest`?/i);
  });
});
