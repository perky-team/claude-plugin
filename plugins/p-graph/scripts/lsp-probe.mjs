#!/usr/bin/env node
// Ask a language server one question over stdio and say whether it answered.
//
// Why this is its own file: the gopls probe in measure-agent.mjs is two `gopls`
// CLI calls, because gopls has a CLI. typescript-language-server and
// pyright-langserver do not — they speak LSP over stdio and nothing else. So the
// probe has to be a real LSP client, and a real LSP client is async, while
// measure-agent.mjs is synchronous end to end. Keeping it here lets that file
// stay synchronous (`execFileSync`) and lets this one be run by hand:
//
//   node lsp-probe.mjs --dir <repo> --command typescript-language-server \
//     --args --stdio --ext .ts --language typescript
//
// It prints one line and exits 0 when the server answered, 1 when it did not.
//
// What counts as "answered" is deliberately not "the process started". The first
// pass of the lsp arm was thrown away because the binary was on PATH, the server
// ran, and it still resolved nothing. So this probe requires a CROSS-FILE
// `references` result, which a server that failed to load its project cannot
// produce.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
// Everything after --args up to the next real flag, so `--args --stdio` works.
const serverArgs = (() => {
  const i = argv.indexOf('--args');
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j];
    if (a.startsWith('--') && !a.startsWith('--stdio') && !a.startsWith('--background')) break;
    out.push(a);
  }
  return out;
})();

const dir = flag('dir');
const command = flag('command');
const ext = flag('ext', '.ts');
const language = flag('language', 'typescript');
const timeoutMs = Number(flag('timeout', 300000));
// How many times to re-ask, and how long to wait between asks, while the server
// builds its program. See the comment on the retry loop below.
const attempts = Number(flag('attempts', 8));
const waitMs = Number(flag('wait', 4000));
const verbose = argv.includes('--verbose');
if (!dir || !command) {
  console.error('usage: lsp-probe.mjs --dir <repo> --command <server> [--args ...] [--ext .ts] [--language typescript]');
  process.exit(2);
}

const die = (msg) => { console.log(`FAILED ${msg}`); process.exit(1); };

// A tracked source file with the wanted extension, biggest first: a big file is
// the one most likely to hold a symbol other files reference, and this probe
// needs a cross-file answer to mean anything.
//
// The directory filter is not tidiness. Left to itself, the first run picked
// `docs/.vitepress/theme/index.ts` in axios — a docs file outside the project's
// tsconfig, which tsserver loads as its own inferred project with no references
// to anything. The probe reported FAILED for a setup that was fine. So prefer
// the directories a project keeps its code in, and let `--file` override when a
// repo does something else.
const SOURCE_DIRS = /^(source|lib|src|packages|internal|core)\//;
const sourceFiles = () => {
  const listed = execFileSync('git', ['ls-files', `*${ext}`], { cwd: dir, encoding: 'utf-8', maxBuffer: 1 << 26 })
    .split('\n')
    .filter((f) => f && !/(^|\/)(test|tests|__tests__|spec|benchmark|examples?|docs?)\//.test(f))
    .filter((f) => !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(f))
    .filter((f) => existsSync(join(dir, f)));
  const preferred = listed.filter((f) => SOURCE_DIRS.test(f));
  const pool = preferred.length ? preferred : listed;
  const sized = pool.map((f) => ({ f, size: readFileSync(join(dir, f)).length }));
  sized.sort((a, b) => b.size - a.size);
  return sized.map((s) => s.f);
};

// The binding of the first import in the file, and where it sits, so the probe
// can ask "where is this declared" about a name whose answer is KNOWN to live in
// another file. That is the whole trick: an imported name always resolves out of
// the file, so a server that loaded the project must jump, and one that loaded
// nothing cannot.
//
// The first version of this probe asked `references` on the biggest file's first
// 25 symbols instead. On got those were `assertAny` and `AcceptableRequestResult`
// — file-local helpers with no outside use — so the probe said FAILED while
// tsserver was working fine.
// A RELATIVE import is preferred over a bare one, and that is not a detail. The
// first version took whichever import came first, which on got is
// `import {randomUUID} from 'node:crypto'` — a builtin, resolved through
// @types/node. The probe then failed the repo for a question the arm never asks:
// every question here is about a symbol declared inside the repository. Relative
// first, bare only as a fallback, and the line says which was used.
const IMPORT = /^\s*import\s+(?:type\s+)?(?:\{\s*(?<named>[A-Za-z_$][\w$]*)|\*\s+as\s+(?<ns>[A-Za-z_$][\w$]*)|(?<def>[A-Za-z_$][\w$]*))/;
const findImports = (text) => {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < Math.min(lines.length, 400); i++) {
    const m = IMPORT.exec(lines[i]);
    if (!m) continue;
    const spec = /from\s+['"]([^'"]+)['"]/.exec(lines[i]);
    if (!spec) continue;
    const name = m.groups.named ?? m.groups.ns ?? m.groups.def;
    const character = lines[i].indexOf(name, m[0].length - name.length);
    if (character < 0) continue;
    found.push({ name, line: i, character, from: spec[1], relative: spec[1].startsWith('.') });
  }
  return found;
};
const firstImport = (text) => {
  const all = findImports(text);
  return all.find((i) => i.relative) ?? all[0] ?? null;
};

// Windows npm shims are .cmd/.ps1, and Node has refused to spawn a .cmd without
// a shell since the 2024 argument-injection fix. Whether the server needs a
// shell here is a finding about the arm, not a detail of the probe, so it is
// printed rather than hidden.
const needsShell = process.platform === 'win32';
const child = spawn(command, serverArgs, {
  cwd: dir,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: needsShell,
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });
child.on('error', (e) => die(`cannot spawn \`${command}\`: ${e.message}`));

let nextId = 1;
const pending = new Map();
const notes = [];
const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ id, method, params });
});
const notify = (method, params) => send({ method, params });

// Length-prefixed framing: one header block, then one JSON body.
let buf = Buffer.alloc(0);
child.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep === -1) return;
    const header = buf.subarray(0, sep).toString('ascii');
    const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? -1);
    if (len < 0) return;
    if (buf.length < sep + 4 + len) return;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf-8');
    buf = buf.subarray(sep + 4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.error ? { __error: msg.error } : msg.result);
      pending.delete(msg.id);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      notes.push(...(msg.params?.diagnostics ?? []).map((d) => d.message));
    } else if (msg.id !== undefined) {
      // A server-to-client request this probe does not implement. Answering null
      // keeps it moving; staying silent makes some servers wait forever.
      send({ id: msg.id, result: null });
    }
  }
});

const withTimeout = (p, what) => Promise.race([
  p,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)), timeoutMs);
  }),
]);

const rootUri = pathToFileURL(dir).href.replace(/\/$/, '');
const uriOf = (rel) => pathToFileURL(join(dir, rel)).href;

// Two URIs for the same file are not the same string. tsserver returns
// `file:///c%3A/…` where pathToFileURL builds `file:///C:/…` — different drive
// letter case, different percent-encoding. Comparing the raw strings made the
// probe read its own file as a cross-file hit, which is the one thing it is
// supposed to prove did not happen.
const normUri = (u) => {
  let s = u;
  try { s = decodeURIComponent(u); } catch { /* keep as given */ }
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
const sameFile = (a, b) => normUri(a) === normUri(b);

try {
  const init = await withTimeout(request('initialize', {
    processId: process.pid,
    rootUri,
    rootPath: dir,
    workspaceFolders: [{ uri: rootUri, name: 'probe' }],
    initializationOptions: {},
    capabilities: {
      textDocument: {
        synchronization: { didSave: false, dynamicRegistration: false },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        references: {},
        publishDiagnostics: {},
      },
      workspace: { workspaceFolders: true, configuration: true },
    },
  }), 'initialize');
  if (init?.__error) die(`initialize failed: ${init.__error.message}`);
  notify('initialized', {});

  // `--refs path:line:character` (1-based line, as an editor shows it) asks one
  // findReferences and prints every location, one per line. Not part of the
  // preflight — it is here for reading a result by hand, which is how the nest
  // miss was explained: the arm said tsserver found 2 of 4 callers, and this
  // said the same 2, from the server directly, with no agent in between.
  if (flag('refs')) {
    const [, path, lineStr, charStr] = /^(.*):(\d+):(\d+)$/.exec(String(flag('refs'))) ?? [];
    if (!path) die('--refs wants path:line:character');
    const uri = uriOf(path);
    notify('textDocument/didOpen', {
      textDocument: { uri, languageId: language, version: 1, text: readFileSync(join(dir, path), 'utf-8') },
    });
    let refs = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await new Promise((r) => { setTimeout(r, waitMs); });
      const got = await withTimeout(request('textDocument/references', {
        textDocument: { uri },
        position: { line: Number(lineStr) - 1, character: Number(charStr) },
        context: { includeDeclaration: false },
      }), 'references');
      if (Array.isArray(got) && got.length) { refs = got; break; }
    }
    console.log(`${refs.length} references`);
    for (const r of refs) {
      const rel = decodeURIComponent(r.uri).replace(/^file:\/\/\//, '').replace(/\\/g, '/');
      console.log(`  ${rel.replace(new RegExp(`^${dir.replace(/\\/g, '/')}/`, 'i'), '')}:${r.range.start.line + 1}`);
    }
    child.kill();
    process.exit(0);
  }

  // Try candidate files until one has an import to ask about. A file without
  // imports says nothing either way, so it is skipped rather than failed.
  const candidates = flag('file') ? [flag('file')] : sourceFiles().slice(0, 12);
  if (!candidates.length) die(`no non-test ${ext} file to probe`);

  let jumped = null;
  let tried = 0;
  let lastWhy = 'no file with an import';
  for (const cand of candidates) {
    const text = readFileSync(join(dir, cand), 'utf-8');
    const imp = firstImport(text);
    if (!imp) continue;
    tried++;
    const uri = uriOf(cand);
    notify('textDocument/didOpen', {
      textDocument: { uri, languageId: language, version: 1, text },
    });
    // The proof. `definition` on an imported name must land in another file: the
    // declaration is not in this one. A server with a loaded project jumps; one
    // that resolved nothing returns [] or null.
    //
    // Asked more than once, and that is the lesson the gopls arm paid for. A
    // server that is still building its program answers an honest "nothing" to
    // the first request rather than waiting — `no active builds` in gopls, an
    // empty array in tsserver. On nest, 2117 packages and 900+ source files, the
    // first ask returned nothing and the fourth returned the declaration. A
    // one-shot probe would have failed a setup that works.
    let out = null;
    for (let attempt = 1; attempt <= attempts && !out; attempt++) {
      if (attempt > 1) await new Promise((r) => { setTimeout(r, waitMs); });
      const def = await withTimeout(request('textDocument/definition', {
        textDocument: { uri },
        position: { line: imp.line, character: imp.character },
      }), `definition of \`${imp.name}\` in ${cand}`);
      const locs = Array.isArray(def) ? def : (def && !def.__error ? [def] : []);
      out = locs.find((l) => {
        const u = l.uri ?? l.targetUri;
        return u && !sameFile(u, uri);
      }) ?? null;
      if (verbose) process.stderr.write(`  attempt ${attempt} on ${cand}: ${out ? 'resolved' : 'nothing'}\n`);
    }
    if (!out) {
      lastWhy = `\`${imp.name}\` (from '${imp.from}') in ${cand} resolved to nothing`;
      continue;
    }
    const target = (out.uri ?? out.targetUri);
    // How many references the server finds for the same name, printed for
    // information: it is the operation the arm actually measures.
    const refs = await withTimeout(request('textDocument/references', {
      textDocument: { uri },
      position: { line: imp.line, character: imp.character },
      context: { includeDeclaration: false },
    }), `references on \`${imp.name}\``);
    jumped = {
      file: cand,
      name: imp.name,
      from: imp.from,
      target: decodeURIComponent(target).split(/[/\\]/).slice(-2).join('/'),
      inNodeModules: /node_modules/.test(target),
      refs: Array.isArray(refs) ? refs.length : 0,
    };
    break;
  }

  const unresolved = notes.filter((m) => /cannot find (module|name)|could not find a declaration/i.test(m));
  const hint = unresolved.length
    ? ` (${unresolved.length} unresolved-import diagnostics, e.g. "${unresolved[0].slice(0, 80)}")`
    : '';

  if (!jumped) die(`${lastWhy} — ${tried} file(s) tried${hint}`);
  console.log(`OK ${jumped.file}: \`${jumped.name}\` from '${jumped.from}' resolves to ${jumped.target}`
    + `, ${jumped.refs} references${hint}`);
  child.kill();
  process.exit(0);
} catch (e) {
  die(`${e.message}${stderr ? ` | stderr: ${stderr.split('\n')[0].slice(0, 160)}` : ''}`);
}
