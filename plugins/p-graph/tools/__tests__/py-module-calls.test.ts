import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/destinations/local-sqlite.mjs';
import { indexFull } from '../lib/index/build.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-pymod-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const write = (rel, src) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, src);
};
async function indexed() {
  const store = openStore(':memory:');
  await indexFull({ root: dir, store, ignorePatterns: [] });
  return store;
}

describe('a Python call qualified by a module name', () => {
  it('resolves through a dotted module path', async () => {
    write('src/pkg/__init__.py', 'from . import cookies\n');
    write('src/pkg/cookies.py', `class CookieJar:
    def clear(self):
        pass
`);
    write('tests/test_jar.py', `import pkg

def test_jar():
    return pkg.cookies.CookieJar()
`);
    const store = await indexed();

    // `pkg.cookies` is a module path, so `pkg.cookies.CookieJar()` names a repo
    // class outright. The object is an attribute, not a plain name, but that says
    // nothing about whether it is a value.
    expect(store.callers('CookieJar').map((n) => n.qname)).toEqual(['test_jar']);

    store.close();
  }, 30000);

  it('refuses a dotted path whose middle segment is a value, not a module', async () => {
    write('src/pkg/__init__.py', `from .status import codes
`);
    write('src/pkg/status.py', `class Codes:
    def get(self, name):
        return name

codes = Codes()
`);
    write('src/pkg/api.py', `def get(url):
    return url
`);
    write('tests/test_codes.py', `import pkg

def test_codes():
    return pkg.codes.get('ok')
`);
    const store = await indexed();

    // `pkg.codes` is an object, not a module, so this is a call on a value. It
    // must not reach the module-level `get`.
    expect(store.callers('get').map((n) => n.qname)).toEqual([]);

    store.close();
  }, 30000);

  it('treats "from . import x" as binding a module when x is a repo module', async () => {
    write('src/app/__init__.py', `from . import cli

def make():
    return cli.AppGroup()
`);
    write('src/app/cli.py', `class AppGroup:
    pass
`);
    const store = await indexed();

    // `from . import cli` binds the submodule `app.cli`, so `cli.AppGroup()` is
    // module-qualified — it is not a call on a value.
    expect(store.callers('AppGroup').map((n) => n.qname)).toEqual(['make']);

    store.close();
  }, 30000);

  it('treats "from . import x as y" as binding a module', async () => {
    write('src/pkg2/__init__.py', '');
    write('src/pkg2/_types.py', `def has_read(obj):
    return True
`);
    write('src/pkg2/models.py', `from . import _types as _t

def prepare(data):
    return _t.has_read(data)
`);
    const store = await indexed();

    expect(store.callers('has_read').map((n) => n.qname)).toEqual(['prepare']);

    store.close();
  }, 30000);

  it('refuses "from . import x" when x is not a repo module', async () => {
    write('src/app2/__init__.py', 'version = "1.0"\n');
    write('src/app2/parsing.py', `def parse(text):
    return text
`);
    write('src/app2/main.py', `from . import version

def show():
    return version.parse('x')
`);
    const store = await indexed();

    // `app2.version` is not a module — it is a string re-exported by the
    // package. A call on it must not reach the repo's own `parse`.
    expect(store.callers('parse').map((n) => n.qname)).toEqual([]);

    store.close();
  }, 30000);

  it('refuses a call on a local that shadows an imported module', async () => {
    write('api.py', `def load(url):
    return url
`);
    write('client.py', `import api

def run(rows):
    api = rows[0]
    api.load('u')
`);
    const store = await indexed();

    // `api` names a row here, not the module. Python makes a name assigned
    // anywhere in a function local to the whole function.
    expect(store.callers('load').map((n) => n.qname)).toEqual([]);

    store.close();
  }, 30000);

  it('refuses a call on a parameter that shadows an imported module', async () => {
    write('api.py', `def fetch(url):
    return url
`);
    write('caller.py', `import api

def run(api):
    api.fetch('u')
`);
    const store = await indexed();

    expect(store.callers('fetch').map((n) => n.qname)).toEqual([]);

    store.close();
  }, 30000);

  it('refuses a standard-library module whose name matches a nested repo package', async () => {
    write('src/app3/__init__.py', '');
    write('src/app3/json/__init__.py', `def dumps(obj):
    return obj
`);
    write('src/app3/provider.py', `import json

def to_text(obj):
    return json.dumps(obj)
`);
    const store = await indexed();

    // The repo does hold a package called json — but at `app3.json`, never at
    // top level. `import json` therefore names the standard library, and this
    // call cannot reach the repo's own `dumps`.
    expect(store.callers('dumps').map((n) => n.qname)).toEqual([]);

    store.close();
  }, 30000);

  it('resolves a module-qualified call to a package that lives under src/', async () => {
    write('src/lib/__init__.py', `from .api import fetch_url
`);
    write('src/lib/api.py', `def fetch_url(url):
    return url
`);
    write('tests/test_lib.py', `import lib

def test_fetch():
    lib.fetch_url('u')
`);
    const store = await indexed();

    // `src` holds a package and is not one itself, so it is a source root and
    // `lib` really is a top-level importable module. Checking a bare
    // `<root>/lib.py` would have refused this.
    expect(store.callers('fetch_url').map((n) => n.qname)).toEqual(['test_fetch']);

    store.close();
  }, 30000);
});
