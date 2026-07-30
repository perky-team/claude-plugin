import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(process.cwd(), 'plugins/p-chat/skills');
const read = (name: string) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf-8');

describe('p-chat skills', () => {
  it('ships init and respond', () => {
    for (const s of ['init', 'respond']) {
      expect(existsSync(join(skillsDir, s, 'SKILL.md'))).toBe(true);
    }
  });
  it('init walks the owner through BotFather + token file and NEVER accepts the token inline', () => {
    const init = read('init');
    expect(init).toContain('@BotFather');
    expect(init).toContain('--token-file');
    expect(init).toMatch(/never.*(paste|inline|chat)/i);
  });
  it('respond documents the at-least-once loop in order: pending -> answer -> send -> ack -> session', () => {
    // Scan the body only — the frontmatter description legitimately summarizes the
    // loop and would otherwise win every first-occurrence comparison. The final
    // step's distinctive token is the Q/A append (plain "session" also names the
    // context read in an earlier step).
    const r = read('respond').replace(/^---[\s\S]*?---/, '');
    const order = ['pending', 'send', 'ack --until', 'Append the Q/A pair'];
    let last = -1;
    for (const token of order) {
      const i = r.indexOf(token);
      expect(i, `missing or out of order: ${token}`).toBeGreaterThan(last);
      last = i;
    }
  });
  it('respond keeps answers phone-sized and grounded', () => {
    expect(read('respond')).toMatch(/short|phone/i);
  });
});
