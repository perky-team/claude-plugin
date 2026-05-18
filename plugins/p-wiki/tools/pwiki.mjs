#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseFrontmatter } from './lib/fm.mjs';
import { extractSummary, renderIndex } from './lib/index.mjs';
import { resolveDestination } from './lib/destination.mjs';
import { TYPES, templateBody, isRawType } from './lib/schema.mjs';
import { kebab, stripDatePrefix } from './lib/slug.mjs';
import { today, findWikiRoot } from './lib/paths.mjs';
import { createHttpClient } from './lib/confluence/http.mjs';
import { ensureSubParent } from './lib/confluence/tree.mjs';
import { writeConfig, validateConfig } from './lib/config.mjs';

const VERSION = '1.1.0';

export function mapErrorToCode(err) {
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

function emitJson(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

function die(msg, code = 1) {
  process.stderr.write(`pwiki: ${msg}\n`);
  process.exit(code);
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
    ['Drift (warnings)', r.warnings.drift ?? [], (e) => `  - [${e.id}] ${e.title} (parent ${e.parentId})`],
  ];
  for (const [title, items, fmt] of sections) {
    out.push(`${title}: ${items.length}`);
    for (const it of items) out.push(fmt(it));
    out.push('');
  }
  out.push(`Total: ${r.totals.errors} errors, ${r.totals.warnings} warnings.`);
  return out.join('\n') + '\n';
}

function makeRealTransport() {
  return async function transport(req) {
    const res = await globalThis.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    let body = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { body = await res.json(); } catch { body = null; }
    } else {
      await res.text(); // drain the body
    }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body };
  };
}

async function initConfluence(args) {
  const email = process.env.PWIKI_CONFLUENCE_EMAIL;
  const token = process.env.PWIKI_CONFLUENCE_TOKEN;
  if (!email || !token) die('PWIKI_CONFLUENCE_EMAIL and PWIKI_CONFLUENCE_TOKEN required', 1);
  const siteUrl = args.site;
  const spaceKey = args.space;
  const parentTitleOrId = args.parent;
  if (!siteUrl || !spaceKey || !parentTitleOrId) die('--site, --space, and --parent required', 1);
  const root = findWikiRoot(process.cwd());
  if (!root) die('not inside a p-wiki repo (no docs/wiki/CLAUDE.md found)', 1);

  const http = createHttpClient({ baseUrl: siteUrl, email, token, transport: makeRealTransport() });
  const spaceRes = await http.get(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
  const space = spaceRes.body?.results?.[0];
  if (!space) emitJson({ error: { code: 'config-invalid', message: `space ${spaceKey} not found` } }, 1);

  let rootPageId;
  if (/^\d+$/.test(parentTitleOrId)) {
    rootPageId = parentTitleOrId;
    await http.get(`/wiki/api/v2/pages/${rootPageId}`);
  } else {
    const cql = `title = "${parentTitleOrId.replace(/"/g, '\\"')}" AND space = "${spaceKey}"`;
    const r = await http.get(`/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=2`);
    const hits = r.body?.results ?? [];
    if (hits.length === 0) emitJson({ error: { code: 'config-invalid', message: `parent page "${parentTitleOrId}" not found in space ${spaceKey} — create it in UI first` } }, 1);
    if (hits.length > 1) emitJson({ error: { code: 'config-invalid', message: `parent page title ambiguous (${hits.length} matches) — pass numeric ID instead` } }, 1);
    rootPageId = hits[0].content?.id ?? hits[0].id;
  }

  const subParents = {};
  for (const type of ['concept', 'person', 'source', 'query']) {
    subParents[type] = await ensureSubParent(http, space.id, rootPageId, type);
  }

  const config = {
    destination: 'confluence',
    confluence: { siteUrl, spaceKey, spaceId: space.id, rootPageId, subParents },
  };
  const v = validateConfig(config);
  if (!v.ok) emitJson({ error: { code: 'internal', message: v.error } }, 3);
  writeConfig(root, config);
  emitJson({ ok: true, configPath: 'docs/wiki/.pwiki.json', spaceId: space.id, rootPageId, subParents }, 0);
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {

if (process.argv.slice(2)[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

const KNOWN = ['new', 'set', 'promote', 'search', 'lint', 'backlinks', 'index', 'init'];
if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);

try {
  if (command === 'new') {
    const type = args._[0];
    if (!TYPES.includes(type)) die(`unknown type: ${type}`, 1);
    if (!args.title) die(`--title required`, 1);

    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);

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
      if (!args['source-url']) die(`--source-url required for type=source`, 1);
      if (!args['source-type']) die(`--source-type required for type=source`, 1);
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
      if (!args.question) die(`--question required for type=query`, 1);
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

    const r = dest.writePage({
      type, slug, frontmatter, body,
      onConflict: args['on-conflict'] ?? 'fail',
    });

    if (r.created) {
      emitJson({ path: r.path, id: r.id, slug: r.slug, created: true }, 0);
    } else {
      emitJson({
        created: false,
        'existing-path': r.existingPath,
        'date-suffix-slug': r.dateSuffixSlug,
      }, 2);
    }
  }

  if (command === 'set') {
    const path = args._[0];
    if (!path) die(`set: <path> required`, 1);
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);
    const mutations = {};

    if (args.field) {
      mutations.setFields = {};
      for (const f of (Array.isArray(args.field) ? args.field : [args.field])) {
        const eq = f.indexOf('=');
        if (eq < 0) die(`--field expects name=value`, 1);
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

    try {
      const r = dest.mutatePage(path, mutations);
      emitJson(r, 0);
    } catch (e) {
      die(e.message, 1);
    }
  }

  if (command === 'promote') {
    const path = args._[0];
    if (!path) die(`promote: <path> required`, 1);
    if (args.to !== 'concept') die(`promote: only --to=concept supported in v1`, 1);
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);

    let source;
    try { source = dest.readPage(path); } catch (e) { die(e.message, 1); }
    if (source.frontmatter.type !== 'query') die(`promote: source must be type=query`, 1);

    const informedBy = source.frontmatter['informed-by'] ?? [];
    const slug = stripDatePrefix(source.frontmatter.id);
    const targetPath = `docs/wiki/pages/concept/${slug}.md`;
    if (dest.pageExists({ type: 'concept', slug })) {
      emitJson({ 'existing-path': targetPath }, 2);
    }

    // Union sources from informed-by pages
    const collected = new Set();
    for (const ibPath of informedBy) {
      try {
        const ibAbs = ibPath.startsWith('docs/wiki/') ? ibPath : `docs/wiki/${ibPath}`;
        const p = dest.readPage(ibAbs);
        for (const s of (p.frontmatter.sources ?? [])) collected.add(s);
      } catch { /* skip missing — lint will surface */ }
    }
    const sourcesArr = [...collected].sort();

    dest.movePage(path, targetPath);
    const mutations = {
      setFields: { type: 'concept', status: 'active', sources: sourcesArr },
      removeFields: ['question', 'informed-by'],
      bumpUpdated: true,
    };
    dest.mutatePage(targetPath, mutations);
    emitJson({ from: path, to: targetPath, sources: sourcesArr }, 0);
  }

  if (command === 'search') {
    const query = args._[0];
    if (!query) die(`search: <query> required`, 1);
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);

    const opts = {
      type: typeof args.type === 'string' ? args.type.split(',').map(s => s.trim()).filter(Boolean) : [],
      tags: typeof args.tags === 'string' ? args.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
      in: args.in ?? 'pages',
      limit: args.limit ? Number(args.limit) : 10,
      snippet: args.snippet === 'false' ? false : true,
    };

    const r = dest.search(query, opts);
    emitJson({ query, total: r.total, results: r.results }, 0);
  }

  if (command === 'lint') {
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);
    const r = dest.lint({});
    const format = args.format ?? 'text';
    if (format === 'json') {
      emitJson(r, 0);
    } else {
      process.stdout.write(formatLintReport(r));
      process.exit(0);
    }
  }

  if (command === 'backlinks') {
    const path = args._[0];
    if (!path) die(`backlinks: <path> required`, 1);
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);

    const maxSuggestions = args['max-suggestions'] !== undefined
      ? Number(args['max-suggestions'])
      : 20;
    const force = args.force === true || args.force === 'true';
    try {
      const r = dest.applyBacklinks({ targetPath: path, maxSuggestions, force });
      if (r.suspicious) emitJson(r, 2);
      emitJson(r, 0);
    } catch (e) {
      die(e.message, 1);
    }
  }

  if (command === 'init') {
    if (!args.confluence) die('use the /p-wiki:init skill for FS scaffolding; only --confluence is supported here', 1);
    await initConfluence(args);
  }

  if (command === 'index') {
    const dest = resolveDestination({ cwd: process.cwd() });
    if (!dest) die(`not inside a p-wiki repo`, 1);
    const format = args.format ?? 'json';

    if (format === 'text') {
      // Render without writing. Build the same input the destination's
      // regenerateIndex builds, but pipe to stdout instead of writing.
      const allPages = dest.listPages({ in: 'pages' });
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
      process.exit(0);
    }
    const r = dest.regenerateIndex();
    emitJson(r, 0);
  }
} catch (err) {
  const code = mapErrorToCode(err);
  const payload = { error: { code, message: err?.message ?? String(err) } };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code === 'schema-violation' || code === 'slug-taken' || code === 'target-exists' ? 2 : code === 'internal' ? 3 : 1);
}

} // end isMain
