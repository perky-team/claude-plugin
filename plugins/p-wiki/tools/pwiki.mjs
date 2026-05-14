#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolveDestination } from './lib/destination.mjs';
import { TYPES, templateBody, isRawType } from './lib/schema.mjs';
import { kebab, stripDatePrefix } from './lib/slug.mjs';
import { today } from './lib/paths.mjs';

const VERSION = '1.0.0';

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

if (process.argv.slice(2)[0] === '--version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (command === 'new') {
  const type = args._[0];
  if (!TYPES.includes(type)) die(`unknown type: ${type}`, 1);
  if (!args.title) die(`--title required`, 1);

  const dest = resolveDestination({ cwd: process.cwd() });
  if (!dest) die(`not inside a p-wiki repo`, 1);

  const slug = args.slug ?? kebab(args.title);
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

function collectArray(args, key) {
  const v = args[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
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

function arrayify(v) { return Array.isArray(v) ? v : [v]; }

function parseFieldValue(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
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

// Other commands (search, lint) and unknown handler land in later tasks.
if (!['new', 'set', 'promote'].includes(command)) {
  const KNOWN = ['new', 'set', 'promote', 'search', 'lint'];
  if (!KNOWN.includes(command)) die(`unknown command: ${command}`, 1);
  process.stderr.write(`pwiki: command '${command}' not yet implemented\n`);
  process.exit(3);
}
