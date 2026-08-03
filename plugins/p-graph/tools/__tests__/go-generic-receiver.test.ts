import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-gen-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};

describe('Go generic receivers', () => {
  it('qualifies a method on a generic type with its receiver type', async () => {
    write('cache/cache.go', `package cache
type Partition[K comparable, V any] struct{}
func (p *Partition[K, V]) Clear() {}
func (p Partition[K, V]) Len() int { return 0 }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.node('cache.Partition.Clear')).toBeTruthy();
    expect(store.node('cache.Partition.Len')).toBeTruthy();
    expect(store.node('cache.Clear')).toBeNull();

    store.close();
  }, 30000);

  it('does not let a generic receiver collide with a plain one', async () => {
    write('main.go', `package main
type Store[T any] struct{}
func (s *Store[T]) Add(v T) {}
type Plain struct{}
func (p *Plain) Add(v int) {}
func use(s *Store[int]) { s.Add(1) }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Two distinct methods, two distinct qnames.
    expect(store.node('main.Store.Add')).toBeTruthy();
    expect(store.node('main.Plain.Add')).toBeTruthy();
    // The call is on a parameter, which Task 4 types. Here we only require that
    // it is NOT wrongly attributed to Plain.
    expect(store.callers('main.Plain.Add')).toEqual([]);

    store.close();
  }, 30000);

  it('reads the package name from a versioned module path', async () => {
    write('internal/caddy/dur.go', `package caddy
type Duration int64
func ParseDuration(s string) Duration { return 0 }
`);
    write('modules/proxy/proxy.go', `package proxy
import "github.com/caddyserver/caddy/v2/internal/caddy"
func Setup(s string) caddy.Duration { return caddy.ParseDuration(s) }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    // Before the fix the import registered the package as "v2", so this call
    // degraded to the bare name "ParseDuration".
    expect(store.callers('caddy.ParseDuration').map((n) => n.qname)).toEqual(['proxy.Setup']);

    store.close();
  }, 30000);

  // The test above imports the package through a nested path
  // ("…/v2/internal/caddy") whose LAST segment is already "caddy", so it
  // passes even before the fix — it never exercises the /vN stripping. The
  // real bug is a package imported at its module ROOT, where the path ends
  // in the version segment itself (this is exactly caddyserver/caddy's own
  // layout: module "github.com/caddyserver/caddy/v2", package "caddy"). A
  // second same-named function in another package is needed to prove it: the
  // old code registers the import under the wrong key ("v2"), so the call
  // falls back to an ambiguous bare name and never resolves at all.
  it('reads the package name from a module path that ends in the version segment', async () => {
    write('pkg/caddy/root.go', `package caddy
func Convert(s string) int { return 0 }
`);
    write('pkg/other/other.go', `package other
func Convert(s string) int { return 1 }
`);
    write('cmd/cmd.go', `package caddycmd
import "github.com/caddyserver/caddy/v2"
func Run(s string) int { return caddy.Convert(s) }
`);
    const store = openStore(':memory:');
    await indexFull({ root: dir, store, ignorePatterns: [] });

    expect(store.callers('caddy.Convert').map((n) => n.qname)).toEqual(['caddycmd.Run']);

    store.close();
  }, 30000);
});
