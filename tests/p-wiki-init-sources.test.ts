import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (rel: string) => readFileSync(join(repoRoot(), rel), 'utf-8');

const INIT_SKILL = 'plugins/p-wiki/skills/init/SKILL.md';
const README = 'plugins/p-wiki/README.md';
const WIKI_TEMPLATE = 'plugins/p-wiki/skills/_shared/templates/wiki-claude-md.template.md';

/** Body of one `## Step N — ...` section, without the following sections. */
function step(content: string, n: number): string {
  const lines = content.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^## Step ${n}\\b`).test(l));
  if (start === -1) throw new Error(`Step ${n} not found in the skill`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * `/p-wiki:init` is the only supported way to attach a read-only source, so the dialog
 * that does it is behaviour, not decoration. Nothing else guards it: the CLI tests cover
 * `pwiki source add`, while these steps are instructions the model follows, and a
 * well-meaning edit could drop them without a single test going red.
 *
 * The two asserts that matter most are the reachability ones. Step 4 used to refuse
 * outright on an existing wiki, which put Step 8 out of reach for every repo that
 * already had one — the exact gap this suite exists to keep closed.
 */
describe('/p-wiki:init — read-only sources step', () => {
  const skill = read(INIT_SKILL);

  it('Step 4 offers sources on an existing wiki instead of only refusing', () => {
    const s4 = step(skill, 4);
    // Still refuses to touch the scaffold...
    expect(s4).toMatch(/already initialised/i);
    // ...but hands off to the sources step rather than stopping there.
    expect(s4).toMatch(/Step 8/);
    expect(s4.toLowerCase()).toMatch(/read-only sources|connect other wikis/);
  });

  it('Step 4 skips the scaffold steps when it jumps ahead', () => {
    // Re-running init must not rewrite docs/wiki/ — the jump has to bypass 5-7.
    expect(step(skill, 4)).toMatch(/skip Steps 5.7|Steps 5.7/);
  });

  it('Step 8 is the sources step and drives the CLI, never a hand-edited config', () => {
    const s8 = step(skill, 8);
    expect(s8.toLowerCase()).toMatch(/read-only source/);
    expect(s8).toMatch(/source add/);
    expect(s8).toMatch(/Never hand-edit `\.pwiki\.json`|never hand-edit/i);
  });

  it('Step 8 covers every way another wiki can be reached', () => {
    const s8 = step(skill, 8);
    for (const kind of ['--kind=fs', '--from-config', '--kind=github', '--kind=gitlab', '--kind=http']) {
      expect(s8, `Step 8 must document ${kind}`).toContain(kind);
    }
    // --from-config is the only practical route to a Confluence source (space + page ids).
    expect(s8.toLowerCase()).toMatch(/confluence/);
  });

  it('Step 8 runs after the scaffold, because the CLI needs docs/wiki/ to exist', () => {
    const lines = skill.split('\n');
    const idx = (n: number) => lines.findIndex((l) => new RegExp(`^## Step ${n}\\b`).test(l));
    expect(idx(8)).toBeGreaterThan(idx(6)); // layout + content files
    expect(idx(8)).toBeGreaterThan(idx(7)); // the repo rule
    expect(step(skill, 8)).toMatch(/after.*scaffold|scaffold exists/i);
  });

  it('Step 8 tells the model what to do with both CLI failures', () => {
    const s8 = step(skill, 8);
    expect(s8).toMatch(/source-unreachable/);
    expect(s8).toMatch(/--no-verify/);
    expect(s8).toMatch(/source-exists/);
  });

  it('the final step reports which sources were connected', () => {
    // Otherwise a user cannot tell whether the step did anything.
    const last = step(skill, 9);
    expect(last.toLowerCase()).toMatch(/sources/);
  });

  it('README points at the same step number as the skill', () => {
    // The README says "its Step 8"; a renumbered skill would make that a lie.
    expect(read(README)).toMatch(/Step 8/);
    expect(skill).toMatch(/^## Step 8\b/m);
  });

  it('the generated wiki CLAUDE.md documents source add for the model', () => {
    // Claude works inside docs/wiki/ with that file loaded; without this line it would
    // fall back to editing .pwiki.json by hand.
    const tpl = read(WIKI_TEMPLATE);
    expect(tpl).toMatch(/source add/);
    expect(tpl.toLowerCase()).toMatch(/never hand-edit/);
  });
});
