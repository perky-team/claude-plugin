#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname, relative } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './lib/fm.mjs';
import { extractSummary, renderIndex } from './lib/index.mjs';
import { resolveDestination, makeDestination, DEFAULT_FS_CONFIG } from './lib/destination.mjs';
import { TYPES, templateBody, isRawType } from './lib/schema.mjs';
import { kebab, stripDatePrefix } from './lib/slug.mjs';
import { today, findWikiRoot } from './lib/paths.mjs';
import { createHttpClient } from './lib/confluence/http.mjs';
import { ensureSubParent } from './lib/confluence/tree.mjs';
import { readConfig, writeConfig, validateConfig } from './lib/config.mjs';
import { syncToMirror } from './lib/sync.mjs';
import { buildBundle } from './lib/bundle.mjs';

// Version comes from the plugin manifest, never a constant here: a release bumps
// plugin.json#version only, so a hardcoded copy drifts silently (this one sat at 3.3.0
// while the plugin shipped 4.12.2). The manifest ships in the same copied tree, so this
// resolves in the installed plugin cache too; a missing manifest degrades to 0.0.0
// rather than killing an unrelated command.
export function readVersion() {
  try {
    const manifest = new URL('../.claude-plugin/plugin.json', import.meta.url);
    return JSON.parse(readFileSync(manifest, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function mapErrorToCode(err) {
  if (err?.code === 'bundle-invalid') return 'bundle-invalid';
  if (err?.message && /invalid \.pwiki\.json/.test(err.message)) return 'config-invalid';
  const s = err?.status;
  if (s === 401 || s === 403) return 'auth-failed';
  if (s === 404) return 'page-not-found';
  if (s === 409) return 'version-conflict';
  if (s === 429) return 'rate-limited';
  if (typeof s === 'number' && s >= 500) return 'network-error';
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ENOTFOUND') return 'network-error';
  return 'internal';
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, val;
      if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
      else { key = a.slice(2); val = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; }
      if (opts[key] === undefined) opts[key] = val;
      else if (Array.isArray(opts[key])) opts[key].push(val);
      else opts[key] = [opts[key], val];
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// Set process.exitCode and return — never call process.exit() here.
//
// A write to a PIPE is asynchronous in Node (a write to a FILE is not), so exiting on
// the next line tears the process down with bytes still queued on the stream. Measured
// on a live board: a `--json` listing delivered 853 212 bytes to a file and 65 536 —
// exactly one pipe buffer — through a pipe. `pwiki get --format=json` on a long page and
// `pwiki search`/`lint --format=json` on a large wiki cross that threshold easily. The
// truncated text fails JSON.parse, a careful consumer catches that and reports "no
// data", so a corrupt read is indistinguishable from an empty one.
// Returning instead lets the event loop flush the stream; the exit code survives.
//
// The bug is invisible on Windows, where pipe writes are synchronous — see
// __tests__/stdout-pipe.test.ts, which must be run under WSL to mean anything.
//
// Callers MUST `return emitJson(...)` / `return die(...)` — these no longer stop
// execution on their own, which is why the command dispatch below lives inside a
// function rather than at module top level. __tests__/no-hard-exit.test.ts pins both.
function emitJson(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = code;
}

function die(msg, code = 1) {
  process.stderr.write(`pwiki: ${msg}\n`);
  process.exitCode = code;
}

function collectArray(args, key) {
  const v = args[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function arrayify(v) { return Array.isArray(v) ? v : [v]; }

function parseFieldValue(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function formatLintReport(r) {
  const out = [];
  const sections = [
    ['Dead links (errors)', r.errors['dead-links'], (e) => `  - ${e.file} → ${e.target}`],
    ['Dead sources (errors)', r.errors['dead-sources'], (e) => `  - ${e.file} → ${e.source}`],
    ['Frontmatter (errors)', r.errors.frontmatter, (e) => `  - ${e.file} — ${e.error ?? `type mismatch: expected ${e.expected}, actual ${e.actual}`}`],
    ['Misparented (errors)', r.errors.misparented ?? [], (e) => `  - [${e.id}] ${e.title} — pwiki-type=${e.pwikiType}, parent=${e.parentId}`],
    ['Orphan pages (warnings)', r.warnings['orphan-pages'], (e) => `  - ${e.file}`],
    ['Underlinked (warnings)', r.warnings.underlinked, (e) => `  - ${e.file} — ${e.count} outgoing link${e.count === 1 ? '' : 's'}`],
    ['Stale (warnings)', r.warnings.stale, (e) => `  - ${e.file} — updated ${e.updated} (${e.days} days)`],
    ['Conflicts (warnings)', r.warnings.conflicts ?? [], (e) => `  - ${e.file} — unresolved conflict${e.since ? ` since ${e.since} (${e.days} days)` : ' (date unknown)'}`],
    ['Source changed (warnings)', r.warnings['source-changed'] ?? [], (e) => `  - ${e.file} — source ${e.source} changed ${e.sourceDate}, page updated ${e.pageUpdated}`],
    ['Drift (warnings)', r.warnings.drift ?? [], (e) => `  - [${e.id}] ${e.title} (parent ${e.parentId})`],
    ['Unknown fields (warnings)', r.warnings['unknown-fields'] ?? [], (e) => `  - ${e.file} — unknown field${e.fields.length === 1 ? '' : 's'}: ${e.fields.join(', ')}`],
  ];
  for (const [title, items, fmt] of sections) {
    out.push(`${title}: ${items.length}`);
    for (const it of items) out.push(fmt(it));
    const sup = title === 'Source changed (warnings)' ? r.suppressed?.['source-changed'] : null;
    if (sup?.count > 0) out.push(`  (suppressed ${sup.count} from reference sources: ${sup.sources.join(', ')})`);
    out.push('');
  }
  out.push(`Total: ${r.totals.errors} errors, ${r.totals.warnings} warnings.`);
  return out.join('\n') + '\n';
}

function makeRealTransport() {
  // Use node:https (not global fetch/undici). The CLI calls process.exit()
  // immediately after a request resolves; undici's keep-alive socket pool is
  // still tearing down then, which trips a libuv assertion (UV_HANDLE_CLOSING)
  // and crashes the process with a non-zero exit code on Windows. A per-request
  // agent with keepAlive:false closes the socket before exit.
  return async function transport(req) {
    const https = await import('node:https');
    const agent = new https.Agent({ keepAlive: false });
    return new Promise((resolve, reject) => {
      const url = new URL(req.url);
      const r = https.request(
        { host: url.host, path: url.pathname + url.search, method: req.method, headers: req.headers, agent },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            let body = null;
            const ct = String(res.headers['content-type'] ?? '');
            if (ct.includes('application/json')) { try { body = JSON.parse(buf); } catch { body = null; } }
            const headers = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
            resolve({ status: res.statusCode ?? 0, headers, body });
          });
        },
      );
      r.on('error', reject);
      if (req.body !== undefined && req.body !== null) r.write(req.body);
      r.end();
    });
  };
}

async function resolveConfluenceBlock(transport, email, token, { site, space, parent, titlePrefix }) {
  const http = createHttpClient({ baseUrl: site, email, token, transport });
  const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(space)}`);
  const spaceObj = spaceRes.body?.results?.[0];
  if (!spaceObj) return emitJson({ error: { code: 'config-invalid', message: `space ${space} not found` } }, 1);

  let rootPageId;
  let rootTitle;
  if (/^\d+$/.test(parent)) {
    rootPageId = parent;
    const rootRes = await http.get(`/wiki/api/v2/pages/${rootPageId}`);
    rootTitle = rootRes.body?.title;
  } else {
    const cql = `title = "${parent.replace(/"/g, '\\"')}" AND space = "${space}"`;
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
    const hits = r.body?.results ?? [];
    if (hits.length === 0) return emitJson({ error: { code: 'config-invalid', message: `parent page "${parent}" not found in space ${space} — create it in UI first` } }, 1);
    if (hits.length > 1) return emitJson({ error: { code: 'config-invalid', message: `parent page title ambiguous (${hits.length} matches) — pass numeric ID instead` } }, 1);
    rootPageId = hits[0].content?.id ?? hits[0].id;
    rootTitle = hits[0].content?.title ?? parent;
  }

  // Structural-page titles must be unique within the space. Default the prefix
  // to the root page's title (itself space-unique), so two wikis in one space
  // never collide. Persisted into the config so sync (ensureStructure) reuses it.
  const prefix = titlePrefix || rootTitle;

  const subParents = {};
  for (const type of ['concept', 'person', 'source', 'query']) {
    subParents[type] = await ensureSubParent(http, spaceObj.id, rootPageId, type, prefix);
  }
  return { kind: 'confluence', siteUrl: site, spaceKey: space, spaceId: spaceObj.id, rootPageId, titlePrefix: prefix, subParents };
}

export async function initConfluence(args, _opts = {}) {
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) return die('PWIKI_CONFLUENCE_EMAIL and PWIKI_CONFLUENCE_TOKEN required', 1);
  const root = findWikiRoot(process.cwd());
  if (!root) return die('not inside a p-wiki repo (no docs/wiki/CLAUDE.md found)', 1);

  const transport = _opts.transport ?? makeRealTransport();
  const destinations = {};
  const mirrors = [];
  let primaryName;

  if (args.confluence) {
    const site = args.site, space = args.space, parent = args.parent;
    if (!site || !space || !parent) return die('--site, --space, and --parent required', 1);
    destinations.confluence = await resolveConfluenceBlock(transport, email, token, { site, space, parent, titlePrefix: args['title-prefix'] });
    primaryName = 'confluence';
  } else {
    destinations.fs = { kind: 'fs' };
    primaryName = 'fs';
  }

  if (args['mirror-fs']) {
    destinations.fs = { kind: 'fs' };
    mirrors.push('fs');
  }

  if (args['mirror-confluence']) {
    const site = args['mirror-site'], space = args['mirror-space'], parent = args['mirror-parent'];
    if (!site || !space || !parent) return die('--mirror-confluence requires --mirror-site, --mirror-space, --mirror-parent', 1);
    destinations['confluence-mirror'] = await resolveConfluenceBlock(transport, email, token, { site, space, parent, titlePrefix: args['mirror-title-prefix'] });
    mirrors.push('confluence-mirror');
  }

  const config = { primary: primaryName, mirrors, destinations };
  const v = validateConfig(config);
  if (!v.ok) return emitJson({ error: { code: 'internal', message: v.error } }, 3);
  writeConfig(root, config);
  return emitJson({ ok: true, configPath: 'docs/wiki/.pwiki.json', primary: primaryName, mirrors }, 0);
}

export async function getPage(args, _opts = {}) {
  const path = args._[0];
  if (!path) return die('get: <path> required', 1);
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
  if (!res) return die('not inside a p-wiki repo', 1);

  const srcName = typeof args.source === 'string' ? args.source : undefined;
  let dest;
  if (!srcName || srcName === res.primaryName) {
    dest = res.primary;
  } else {
    const idx = res.sourceNames.indexOf(srcName);
    if (idx === -1) return emitJson({ error: { code: 'unknown-source', message: `unknown source: ${srcName}` } }, 1);
    dest = res.sources[idx];
  }

  let page;
  try {
    // FS readPage is synchronous, Confluence is async; a single await covers both.
    page = await dest.readPage(path);
  } catch (e) {
    // These branches match by message because FS errors are plain Error objects
    // with no .status — the top-level mapErrorToCode would otherwise classify them
    // as 'internal'/exit 3. Confluence transport errors DO carry .status/.code, so
    // we re-throw those and let mapErrorToCode handle them.
    const msg = e?.message ?? String(e);
    if (/^page not found:/.test(msg)) return emitJson({ error: { code: 'page-not-found', message: msg } }, 1);
    if (/not a confluence:\/\//.test(msg)) return emitJson({ error: { code: 'bad-path', message: msg } }, 1);
    throw e;
  }

  if ((args.format ?? 'text') === 'json') {
    return emitJson({ path: page.path, frontmatter: page.frontmatter, body: page.body }, 0);
  }
  process.stdout.write(serializeFrontmatter(page.frontmatter, page.body));
}

export async function searchCommand(args, _opts = {}) {
  const query = args._[0];
  if (!query) return die(`search: <query> required`, 1);
  const res = resolveDestination({ cwd: process.cwd(), transport: _opts.transport ?? makeRealTransport() });
  if (!res) return die(`not inside a p-wiki repo`, 1);

  const opts = {
    type: typeof args.type === 'string' ? args.type.split(',').map(s => s.trim()).filter(Boolean) : [],
    tags: typeof args.tags === 'string' ? args.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    in: args.in ?? 'pages',
    limit: args.limit ? Number(args.limit) : 10,
    snippet: args.snippet === 'false' ? false : true,
  };

  const warnings = [];
  const primary = await res.primary.search(query, opts);
  let results = primary.results.map(r => ({ ...r, source: res.primaryName }));

  for (let i = 0; i < res.sourceNames.length; i++) {
    const name = res.sourceNames[i];
    try {
      const dest = res.sources[i];                       // construction may throw → caught below
      const sr = await dest.search(query, opts);
      results = results.concat(sr.results.map(r => ({ ...r, source: name })));
    } catch (e) {
      warnings.push({ source: name, code: mapErrorToCode(e), message: e?.message ?? String(e) });
    }
  }

  const limit = opts.limit;
  const trimmed = results.slice(0, limit);
  return emitJson({ query, total: trimmed.length, results: trimmed, warnings }, 0);
}

// ---------------------------------------------------------------------------
// source add — register another wiki as a read-only source
// ---------------------------------------------------------------------------

const SOURCE_KINDS = ['fs', 'github', 'gitlab', 'http'];

/** Build a destinations block from --kind plus its per-kind flags. Returns {block} or {error}. */
function buildSourceBlock(args) {
  const kind = typeof args.kind === 'string' ? args.kind : '';
  if (kind === 'fs') {
    if (typeof args.path !== 'string' || !args.path) {
      return { error: '--path required for --kind=fs (the other wiki\'s repo root, the folder holding docs/wiki)' };
    }
    return { block: { kind: 'fs', path: args.path } };
  }
  if (kind === 'github') {
    for (const f of ['owner', 'repo']) if (typeof args[f] !== 'string' || !args[f]) return { error: `--${f} required for --kind=github` };
    const block = { kind: 'github', owner: args.owner, repo: args.repo };
    if (typeof args.ref === 'string') block.ref = args.ref;
    if (typeof args['index-path'] === 'string') block.indexPath = args['index-path'];
    if (typeof args['api-base-url'] === 'string') block.apiBaseUrl = args['api-base-url'];
    return { block };
  }
  if (kind === 'gitlab') {
    if (typeof args.project !== 'string' || !args.project) return { error: '--project required for --kind=gitlab (group/repo form)' };
    const block = { kind: 'gitlab', project: args.project };
    if (typeof args['base-url'] === 'string') block.baseUrl = args['base-url'];
    if (typeof args.ref === 'string') block.ref = args.ref;
    if (typeof args['index-path'] === 'string') block.indexPath = args['index-path'];
    return { block };
  }
  if (kind === 'http') {
    if (typeof args.url !== 'string' || !args.url) return { error: '--url required for --kind=http' };
    const block = { kind: 'http', url: args.url };
    const header = args['auth-header'];
    const tokenEnv = args['auth-token-env'];
    if (header !== undefined || tokenEnv !== undefined) {
      if (typeof header !== 'string' || !header || typeof tokenEnv !== 'string' || !tokenEnv) {
        return { error: '--auth-header and --auth-token-env must be set together' };
      }
      block.authHeader = header;
      block.authTokenEnv = tokenEnv;
    }
    return { block };
  }
  if (kind === 'confluence') {
    return { error: 'a confluence source needs that space\'s ids — point --from-config at the other wiki\'s .pwiki.json instead of passing --kind=confluence' };
  }
  return { error: `--kind must be one of ${SOURCE_KINDS.join(', ')} (or use --from-config=<path to another wiki's .pwiki.json>)` };
}

/** Copy a destinations block out of another wiki's .pwiki.json. Returns {block} or {error}. */
function blockFromConfig(fromPath, args, root) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(fromPath, 'utf-8'));
  } catch (e) {
    return { error: `cannot read ${fromPath}: ${e?.message ?? String(e)}` };
  }
  const fromName = typeof args['from-destination'] === 'string' ? args['from-destination'] : raw?.primary;
  const block = raw?.destinations?.[fromName];
  if (!block || typeof block !== 'object') {
    return { error: `no destination "${fromName}" in ${fromPath}` };
  }
  const copy = { ...block };
  if (copy.kind === 'fs' && !copy.path) {
    // That config lives at <its-root>/docs/wiki/.pwiki.json, so its repo root is two
    // levels up. Store the path relative to our root (forward slashes) so the config
    // stays readable and portable across machines.
    const otherRoot = resolve(dirname(resolve(fromPath)), '..', '..');
    copy.path = relative(root, otherRoot).split('\\').join('/') || '.';
  }
  return { block: copy };
}

/** Cheap reachability probe: FS checks the folder, every other kind runs a 1-hit search. */
async function verifySource(name, block, root, transport) {
  if (block.kind === 'fs') {
    // Check the same marker `findWikiRoot` uses, not just the folder: a path that happens
    // to hold an empty docs/wiki/ (a stale checkout, a half-deleted wiki, the wrong repo)
    // would otherwise pass the probe and then return nothing on every search.
    const abs = resolve(root, block.path);
    const marker = join(abs, 'docs', 'wiki', 'CLAUDE.md');
    if (!existsSync(marker)) {
      throw new Error(`no p-wiki at ${join(abs, 'docs', 'wiki')} (expected its CLAUDE.md)`);
    }
    return;
  }
  const dest = makeDestination(name, block, root, { transport });
  await dest.search('p-wiki-source-check', { type: [], tags: [], in: 'pages', limit: 1, snippet: false });
}

export async function sourceAdd(args, _opts = {}) {
  const name = args._[0];
  if (!name) return emitJson({ error: { code: 'bad-args', message: 'source add: <name> required' } }, 1);
  const root = findWikiRoot(process.cwd());
  if (root === null) return die('not inside a p-wiki repo', 1);

  let cfg;
  try {
    cfg = readConfig(root) ?? JSON.parse(JSON.stringify(DEFAULT_FS_CONFIG));
  } catch (e) {
    return emitJson({ error: { code: 'config-invalid', message: `cannot read .pwiki.json: ${e?.message ?? String(e)}` } }, 1);
  }
  // One name, one role: a name already in destinations is the primary, a mirror, or an
  // existing source, and silently repurposing it would change where writes go.
  if (cfg?.destinations?.[name]) {
    return emitJson({ error: { code: 'source-exists', message: `destinations.${name} already exists — pick another name` } }, 1);
  }

  const built = typeof args['from-config'] === 'string'
    ? blockFromConfig(args['from-config'], args, root)
    : buildSourceBlock(args);
  if (built.error) return emitJson({ error: { code: 'bad-args', message: built.error } }, 1);

  const next = {
    ...cfg,
    sources: [...(cfg.sources ?? []), name],
    destinations: { ...cfg.destinations, [name]: built.block },
  };
  const v = validateConfig(next);
  if (!v.ok) return emitJson({ error: { code: 'config-invalid', message: v.error } }, 1);

  // Verify before writing: a wrong path or repo name would otherwise sit in the config
  // and only surface later, as empty search results in an unrelated session.
  let verified = false;
  if (!args['no-verify']) {
    try {
      await verifySource(name, built.block, root, _opts.transport ?? makeRealTransport());
      verified = true;
    } catch (e) {
      return emitJson({
        error: {
          code: 'source-unreachable',
          message: `${e?.message ?? String(e)} — fix the details, or pass --no-verify to add it anyway`,
        },
      }, 1);
    }
  }

  writeConfig(root, next);
  return emitJson({ ok: true, name, kind: built.block.kind, sources: next.sources, verified }, 0);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

// The dispatch lives in a FUNCTION, not at module top level, purely so that every
// `return emitJson(...)` / `return die(...)` below is legal. It used to be top-level
// code that relied on emitJson calling process.exit() to stop; now that emitJson only
// sets the exit code (see its comment — a hard exit truncates a piped write), a bare
// call would fall through into the next command's block.
async function main() {

if (process.argv.slice(2)[0] === '--version') {
  process.stdout.write(`${readVersion()}\n`);
  return;
}

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

const KNOWN = ['new', 'set', 'promote', 'search', 'lint', 'backlinks', 'index', 'reindex', 'init', 'sync', 'get', 'source', 'upgrade-schema'];
if (!KNOWN.includes(command)) return die(`unknown command: ${command}`, 1);

try {
  if (command === 'new') {
    const type = args._[0];
    if (!TYPES.includes(type)) return die(`unknown type: ${type}`, 1);
    if (!args.title) return die(`--title required`, 1);

    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;

    let slug = args.slug ?? kebab(args.title);
    if (type === 'query') slug = `${today()}-${slug}`;
    const tags = typeof args.tags === 'string' ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Build per-type frontmatter
    let frontmatter;
    let body;
    if (type === 'concept' || type === 'person') {
      frontmatter = {
        id: slug, type, title: args.title,
        created: today(), updated: today(),
        status: 'active', tags,
        sources: collectArray(args, 'source'),
      };
      body = templateBody(type, { title: args.title });
    } else if (type === 'source') {
      if (!args['source-url']) return die(`--source-url required for type=source`, 1);
      if (!args['source-type']) return die(`--source-type required for type=source`, 1);
      frontmatter = {
        id: slug, type, title: args.title,
        created: today(), updated: today(),
        status: 'active', tags,
        sources: collectArray(args, 'source'),
        'source-url': args['source-url'],
        'source-type': args['source-type'],
      };
      body = templateBody(type, { title: args.title });
    } else if (type === 'query') {
      if (!args.question) return die(`--question required for type=query`, 1);
      frontmatter = {
        id: slug, type, title: args.title,
        created: today(), status: 'filed', tags,
        question: args.question,
        'informed-by': collectArray(args, 'informed-by'),
      };
      body = templateBody(type, { title: args.title, question: args.question });
    } else if (isRawType(type)) {
      const sourceUrl = type === 'raw-article' ? (args['source-url'] ?? null) : null;
      const sourceType = type === 'raw-paste' ? 'doc' : (args['source-type'] ?? 'doc');
      let pasteBody = '';
      if (args['ingested-from'] === '-' || args['ingested-from'] === true) {
        pasteBody = readFileSync(0, 'utf-8');
      } else if (typeof args['ingested-from'] === 'string') {
        pasteBody = readFileSync(args['ingested-from'], 'utf-8');
      }
      frontmatter = {
        id: slug, type, title: args.title,
        'source-url': sourceUrl, 'source-type': sourceType,
        ingested: today(), compiled: false, 'compiled-to': [],
      };
      body = templateBody(type, { title: args.title, body: pasteBody });
    }

    const r = await dest.writePage({
      type, slug, frontmatter, body,
      onConflict: args['on-conflict'] ?? 'fail',
    });

    if (r.created) {
      return emitJson({ path: r.path, id: r.id, slug: r.slug, created: true }, 0);
    } else {
      return emitJson({
        created: false,
        'existing-path': r.existingPath,
        'date-suffix-slug': r.dateSuffixSlug,
      }, 2);
    }
  }

  if (command === 'set') {
    const path = args._[0];
    if (!path) return die(`set: <path> required`, 1);
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;
    const mutations = {};

    if (args.field) {
      mutations.setFields = {};
      for (const f of (Array.isArray(args.field) ? args.field : [args.field])) {
        const eq = f.indexOf('=');
        if (eq < 0) return die(`--field expects name=value`, 1);
        mutations.setFields[f.slice(0, eq)] = parseFieldValue(f.slice(eq + 1));
      }
    }
    if (args['add-tag']) mutations.addTag = args['add-tag'];
    if (args['remove-tag']) mutations.removeTag = args['remove-tag'];
    if (args['add-source']) mutations.addSources = arrayify(args['add-source']);
    if (args['add-informed-by']) mutations.addInformedBy = arrayify(args['add-informed-by']);
    if (args['add-compiled-to']) mutations.addCompiledTo = arrayify(args['add-compiled-to']);
    if (args['bump-updated']) mutations.bumpUpdated = true;
    if (args['mark-compiled']) mutations.markCompiled = true;
    if (args['conflict-since'] !== undefined) {
      const cs = String(args['conflict-since']);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cs)) return die('set: --conflict-since expects YYYY-MM-DD', 1);
      mutations.setFields = { ...(mutations.setFields ?? {}), 'conflict-since': cs };
    }
    if (args['clear-conflict']) {
      mutations.removeFields = [...(mutations.removeFields ?? []), 'conflict-since'];
      mutations.bumpUpdated = true;
    }

    try {
      const r = await dest.mutatePage(path, mutations);
      return emitJson(r, 0);
    } catch (e) {
      return die(e.message, 1);
    }
  }

  if (command === 'promote') {
    const path = args._[0];
    if (!path) return die(`promote: <path> required`, 1);
    if (args.to !== 'concept') return die(`promote: only --to=concept supported in v1`, 1);
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;

    let source;
    try { source = await dest.readPage(path); } catch (e) { return die(e.message, 1); }
    if (source.frontmatter.type !== 'query') return die(`promote: source must be type=query`, 1);

    const informedBy = source.frontmatter['informed-by'] ?? [];
    const slug = stripDatePrefix(source.frontmatter.id);
    const targetPath = `docs/wiki/pages/concept/${slug}.md`;
    if (await dest.pageExists({ type: 'concept', slug })) {
      return emitJson({ 'existing-path': targetPath }, 2);
    }

    // Union sources from informed-by pages
    const collected = new Set();
    for (const ibPath of informedBy) {
      try {
        const ibAbs = ibPath.startsWith('docs/wiki/') ? ibPath : `docs/wiki/${ibPath}`;
        const p = await dest.readPage(ibAbs);
        for (const s of (p.frontmatter.sources ?? [])) collected.add(s);
      } catch { /* skip missing — lint will surface */ }
    }
    const sourcesArr = [...collected].sort();

    await dest.movePage(path, targetPath);
    const mutations = {
      setFields: { type: 'concept', status: 'active', sources: sourcesArr },
      removeFields: ['question', 'informed-by'],
      bumpUpdated: true,
    };
    await dest.mutatePage(targetPath, mutations);
    return emitJson({ from: path, to: targetPath, sources: sourcesArr }, 0);
  }

  if (command === 'search') {
    await searchCommand(args);
  }

  if (command === 'get') {
    await getPage(args);
  }

  if (command === 'source') {
    const sub = args._[0];
    if (sub !== 'add') return die(`unknown source subcommand: ${sub ?? '(none)'} — only "add" exists`, 1);
    await sourceAdd({ ...args, _: args._.slice(1) });
  }

  if (command === 'lint') {
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;
    const r = await dest.lint({});
    const format = args.format ?? 'text';
    if (format === 'json') {
      return emitJson(r, 0);
    } else {
      process.stdout.write(formatLintReport(r));
      return;
    }
  }

  if (command === 'backlinks') {
    const path = args._[0];
    if (!path) return die(`backlinks: <path> required`, 1);
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;

    const maxSuggestions = args['max-suggestions'] !== undefined
      ? Number(args['max-suggestions'])
      : 20;
    const force = args.force === true || args.force === 'true';
    try {
      const r = await dest.applyBacklinks({ targetPath: path, maxSuggestions, force });
      if (r.suspicious) return emitJson(r, 2);
      return emitJson(r, 0);
    } catch (e) {
      return die(e.message, 1);
    }
  }

  if (command === 'init') {
    if (!args.confluence && !args['mirror-confluence']) return die('use the /p-wiki:init skill for FS scaffolding; only --confluence is supported here', 1);
    await initConfluence(args);
  }

  // `init` writes docs/wiki/CLAUDE.md once and never touches it again (its Step 4 skips
  // the scaffold for an existing wiki), so a rule added to the shipped template reaches
  // new wikis only. Every wiki created before the change keeps compiling under the old
  // rules forever. This command is the missing path: it reports the drift and, with
  // --write, replaces the file from the template that ships with this plugin version.
  if (command === 'upgrade-schema') {
    const root = findWikiRoot(process.cwd());
    if (!root) return die(`not inside a p-wiki repo`, 1);
    const target = join(root, 'docs', 'wiki', 'CLAUDE.md');
    const format = args.format ?? 'text';

    let shipped;
    try {
      shipped = readFileSync(new URL('../skills/_shared/templates/wiki-claude-md.template.md', import.meta.url), 'utf-8');
    } catch {
      return die('cannot read the bundled schema template; the plugin install may be incomplete', 1);
    }
    const current = existsSync(target) ? readFileSync(target, 'utf-8') : '';
    // Compare and write line-ending-agnostically. The shipped template is checked in with
    // CRLF; a wiki's copy is usually LF. Comparing raw bytes reports every single line as
    // changed, and writing the template verbatim would rewrite the whole file in the user's
    // repo for no semantic reason. So: normalise for the comparison, and write back in
    // whatever ending the target already uses.
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const shippedN = norm(shipped);
    const currentN = norm(current);
    const inSync = currentN === shippedN;
    const wrote = !inSync && args.write === true;
    if (wrote) {
      const targetUsesCrlf = /\r\n/.test(current);
      writeFileSync(target, targetUsesCrlf ? shippedN.replace(/\n/g, '\r\n') : shippedN);
    }

    // A unified diff would need a diff library the plugin deliberately does not carry
    // (zero deps), so report the shape of the drift instead: which lines differ. That
    // is enough to decide whether to take the update, and `git diff` shows the rest
    // once --write has run.
    const cur = currentN.split('\n');
    const shp = shippedN.split('\n');
    const curSet = new Set(cur);
    const shpSet = new Set(shp);
    const added = shp.filter(l => l.trim() && !curSet.has(l));
    const removed = cur.filter(l => l.trim() && !shpSet.has(l));

    if (format === 'json') {
      return emitJson({
        target: relative(root, target).split(/[\\/]/).join('/'),
        inSync, wrote,
        pluginVersion: readVersion(),
        added: added.length, removed: removed.length,
        addedLines: added.slice(0, 40), removedLines: removed.slice(0, 40),
      }, 0);
    }
    if (inSync) {
      process.stdout.write(`docs/wiki/CLAUDE.md matches the schema shipped with p-wiki ${readVersion()}. Nothing to do.\n`);
      return;
    }
    process.stdout.write(`docs/wiki/CLAUDE.md differs from the schema shipped with p-wiki ${readVersion()}:\n`);
    process.stdout.write(`  ${added.length} line(s) only in the shipped template, ${removed.length} only in your file\n`);
    for (const l of added.slice(0, 20)) process.stdout.write(`  + ${l}\n`);
    for (const l of removed.slice(0, 20)) process.stdout.write(`  - ${l}\n`);
    if (added.length + removed.length > 40) process.stdout.write(`  … (truncated)\n`);
    process.stdout.write(
      wrote
        ? `\nWritten. Review with \`git diff docs/wiki/CLAUDE.md\`.\n`
        : `\nNothing written. Re-run with --write to take the shipped schema.\n` +
          `Local edits to this file are overwritten, so commit or copy them first.\n`,
    );
    return;
  }

  if (command === 'index') {
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die(`not inside a p-wiki repo`, 1);
    const dest = res.primary;
    const format = args.format ?? 'json';

    if (format === 'text') {
      if (dest.kind !== 'fs') return die('index --format=text is only supported for filesystem wikis; use --format=json', 1);
      // Render without writing. Build the same input the destination's
      // regenerateIndex builds, but pipe to stdout instead of writing.
      const allPages = await dest.listPages({ in: 'pages' });
      const groups = { concept: [], person: [], source: [], query: [] };
      for (const { path: pagePath, frontmatter } of allPages) {
        const t = frontmatter.type;
        if (!(t in groups)) continue;
        const text = readFileSync(`${dest.rootPath}/${pagePath}`, 'utf-8');
        const { body } = parseFrontmatter(text);
        const relPath = pagePath.startsWith('docs/wiki/') ? pagePath.slice('docs/wiki/'.length) : pagePath;
        groups[t].push({
          id: frontmatter.id,
          title: frontmatter.title,
          path: relPath,
          summary: extractSummary(body),
        });
      }
      for (const k of Object.keys(groups)) {
        groups[k].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      process.stdout.write(renderIndex(groups));
      return;
    }
    const r = await dest.regenerateIndex();
    const root = findWikiRoot(process.cwd());
    const bundle = await buildBundle(dest);
    writeFileSync(join(root, 'docs', 'wiki', 'index.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
    return emitJson(r, 0);
  }

  if (command === 'reindex') {
    const res = resolveDestination({ cwd: process.cwd(), transport: makeRealTransport() });
    if (!res) return die('not inside a p-wiki repo', 1);
    const idx = await res.primary.regenerateIndex();                       // writes index.md
    const root = findWikiRoot(process.cwd());
    const bundle = await buildBundle(res.primary);
    writeFileSync(join(root, 'docs', 'wiki', 'index.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
    return emitJson({ index: idx, bundle: { pages: bundle.pages.length, path: 'docs/wiki/index.json' } });
  }

  if (command === 'sync') {
    const env = { cwd: process.cwd(), transport: makeRealTransport() };
    const res = resolveDestination(env);
    if (!res) return die(`not inside a p-wiki repo`, 1);

    const format = args.format ?? 'text';
    const results = [];
    let worstExit = 0;
    for (let i = 0; i < res.mirrorNames.length; i++) {
      const name = res.mirrorNames[i];
      const mirror = res.mirrors[i];
      const start = Date.now();
      try {
        const counters = await syncToMirror(res.primary, mirror, {
          mirrorName: name,
          onWarn: (info) => process.stderr.write(`[sync] cross-link target ${info.type}/${info.slug} not found on mirror ${name}\n`),
        });
        const elapsed = Date.now() - start;
        results.push({ name, ...counters, elapsedMs: elapsed });
        if (format === 'text') {
          process.stdout.write(`Syncing primary=${res.primaryName} → mirror=${name}\n`);
          process.stdout.write(`  pass 1: writing ${counters.written} pages\n`);
          process.stdout.write(`  pass 2: rewriting cross-links in ${counters.rewritten} pages\n`);
          process.stdout.write(`  pass 3: deleting ${counters.deleted} pages\n`);
          process.stdout.write(`  pass 4: regenerating Index\n`);
          process.stdout.write(`Done in ${(elapsed / 1000).toFixed(1)}s.\n`);
        }
      } catch (e) {
        const code = mapErrorToCode(e);
        worstExit = Math.max(worstExit, 1);
        results.push({ name, error: { code, message: e?.message ?? String(e) } });
        process.stderr.write(`[sync] mirror ${name} failed: ${e?.message ?? e}\n`);
      }
    }
    if (format === 'json') return emitJson({ ok: worstExit === 0, mirrors: results }, worstExit);
    process.exitCode = worstExit;
    return;
  }
} catch (err) {
  const code = mapErrorToCode(err);
  const payload = { error: { code, message: err?.message ?? String(err) } };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exitCode = code === 'schema-violation' || code === 'slug-taken' || code === 'target-exists' || code === 'config-invalid' ? 2 : code === 'internal' ? 3 : 1;
  return;
}

} // end main

if (isMain) main();
