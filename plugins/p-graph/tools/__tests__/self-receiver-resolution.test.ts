import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-self-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, src) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
}
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

// A call on the object the enclosing method belongs to — `s.m()` in Go,
// `this.m()` in TS/JS/C++, `self.m()` in Python. The owning type is known right
// there in the syntax, so the target must be named exactly instead of being left
// as a bare name that collides with every same-named method in the repo.
describe('calls on the enclosing method\'s own receiver', () => {
  it('binds a Go receiver call to its own type, not to a same-named method elsewhere', async () => {
    write('api/server.go', `package api
type Server struct{}
func (s *Server) Run() { s.helper() }
func (s *Server) helper() {}
`);
    write('api/worker.go', `package api
type Worker struct{}
func (w *Worker) Work() { w.helper() }
func (w *Worker) helper() {}
`);
    const store = await indexed();

    expect(store.callers('api.Server.helper').map((n) => n.qname)).toEqual(['api.Server.Run']);
    expect(store.callers('api.Worker.helper').map((n) => n.qname)).toEqual(['api.Worker.Work']);
    expect(store.status().unresolved_calls).toBe(0);

    store.close();
  }, 30000);

  it('keeps the bare-name fallback for a promoted method of an embedded struct', async () => {
    write('emb/emb.go', `package emb
type Base struct{}
func (b *Base) Shared() {}
type Wrap struct{ Base }
func (w *Wrap) Do() { w.Shared() }
`);
    const store = await indexed();

    // emb.Wrap.Shared does not exist — the method is promoted from Base. The
    // qualified guess must fall back to the unique bare name, not vanish.
    expect(store.callers('emb.Base.Shared').map((n) => n.qname)).toEqual(['emb.Wrap.Do']);

    store.close();
  }, 30000);

  it('binds self.m() to a method inherited from a separate base class (non-Go plain fallback)', async () => {
    write('base.py', `class Base:
    def find_handler(self):
        return 1

class App(Base):
    def dispatch(self):
        return self.find_handler()
`);
    // A same-named method on an unrelated class, in a DIFFERENT language. Go's
    // own-receiver fallback is gated on an "#embed" row; Python has none, so it
    // keeps a plain "unique bare name, same language" fallback. Without the
    // language scoping, "find_handler" would match this decoy too and be
    // ambiguous; the fallback must stay scoped to lang: 'py' to fire at all.
    write('router.js', `class Router {
  find_handler() {}
}
`);
    const store = await indexed();

    // App does not define find_handler itself — Pass A's exact qname match
    // ("App.find_handler") misses, so this can only resolve through Pass C's
    // plain fallback, the path every other case in this file skips because it
    // calls a method the class defines on itself.
    expect(store.callers('Base.find_handler').map((n) => n.qname)).toEqual(['App.dispatch']);

    store.close();
  }, 30000);

  it('leaves a Go call on a non-receiver variable alone', async () => {
    write('api/api.go', `package api
type Server struct{}
func (s *Server) helper() {}
type Worker struct{}
func (w *Worker) helper() {}
func Free(x *Server) { x.helper() }
`);
    const store = await indexed();

    // `x` is a parameter, not the enclosing receiver (Free is not a method), so
    // the call stays unattributed rather than being guessed at.
    expect(store.callers('api.Server.helper')).toEqual([]);
    expect(store.gapsFor('api.Server.helper')).toHaveLength(1);

    store.close();
  }, 30000);

  it('binds this.m() to the enclosing TypeScript class', async () => {
    write('repo.ts', `export class UserRepo {
  get(id: string) { return id; }
  load(id: string) { return this.get(id); }
}
export class GroupRepo {
  get(id: string) { return id; }
}
`);
    const store = await indexed();

    expect(store.callers('UserRepo.get').map((n) => n.qname)).toEqual(['UserRepo.load']);
    expect(store.callers('GroupRepo.get')).toEqual([]);

    store.close();
  }, 30000);

  it('binds self.m() to the enclosing Python class', async () => {
    write('repo.py', `class UserRepo:
    def get(self, i):
        return i

    def load(self, i):
        return self.get(i)

class GroupRepo:
    def get(self, i):
        return i
`);
    const store = await indexed();

    expect(store.callers('UserRepo.get').map((n) => n.qname)).toEqual(['UserRepo.load']);
    expect(store.callers('GroupRepo.get')).toEqual([]);

    store.close();
  }, 30000);

  it('binds this->m() to the enclosing C++ class', async () => {
    write('cls.cpp', `class Alpha {
public:
  void run() { this->helper(); }
  void helper() {}
};
class Beta {
public:
  void helper() {}
};
`);
    const store = await indexed();

    expect(store.callers('Alpha.helper').map((n) => n.qname)).toEqual(['Alpha.run']);
    expect(store.callers('Beta.helper')).toEqual([]);

    store.close();
  }, 30000);
});
