import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, changedLines } from '../../scripts/measure-tracker/snapshot.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'snap-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const write = (dir: string, rel: string, text: string) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

describe('snapshot', () => {
  it('copies files and skips node_modules', () => {
    const src = join(root, 'src');
    write(src, 'a.js', 'one\n');
    write(src, 'node_modules/big/index.js', 'huge\n');
    const dest = snapshot(src, join(root, 'dest'));
    expect(existsSync(join(dest, 'a.js'))).toBe(true);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
  });

  it('copies .git, because the agent may have committed', () => {
    const src = join(root, 'src');
    write(src, '.git/HEAD', 'ref: refs/heads/main\n');
    const dest = snapshot(src, join(root, 'dest'));
    expect(existsSync(join(dest, '.git', 'HEAD'))).toBe(true);
  });

  it('skips node_modules at any depth', () => {
    const src = join(root, 'src');
    write(src, 'lib/index.js', 'one\n');
    write(src, 'lib/node_modules/deep/index.js', 'huge\n');
    const dest = snapshot(src, join(root, 'dest'));
    expect(existsSync(join(dest, 'lib', 'index.js'))).toBe(true);
    expect(existsSync(join(dest, 'lib', 'node_modules'))).toBe(false);
  });
});

describe('changedLines', () => {
  it('is zero for two identical trees', () => {
    write(join(root, 'a'), 'f.js', 'one\ntwo\n');
    write(join(root, 'b'), 'f.js', 'one\ntwo\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(0);
  });

  it('counts a line changed in the middle once', () => {
    write(join(root, 'a'), 'f.js', 'one\ntwo\nthree\n');
    write(join(root, 'b'), 'f.js', 'one\nTWO\nthree\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(1);
  });

  it('counts a blank line added in the middle', () => {
    write(join(root, 'a'), 'f.js', 'one\ntwo\n');
    write(join(root, 'b'), 'f.js', 'one\n\ntwo\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(1);
  });

  it('counts every line of a new file', () => {
    write(join(root, 'a'), 'f.js', 'one\n');
    write(join(root, 'b'), 'f.js', 'one\n');
    write(join(root, 'b'), 'g.js', 'x\ny\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(2);
  });

  it('ignores .git, which changes for reasons that are not work', () => {
    write(join(root, 'a'), '.git/index', 'x\n');
    write(join(root, 'b'), '.git/index', 'y\nz\n');
    expect(changedLines(join(root, 'a'), join(root, 'b'))).toBe(0);
  });
});
