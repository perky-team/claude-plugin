import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeEvent } from '../event.mjs';
import { watchPath, safeRead } from '../watch.mjs';

export function readFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}

function firstParagraph(body) {
  const out = [];
  for (const l of (body ?? '').split('\n')) {
    const t = l.trim();
    if (t === '' || /^#{1,6}\s/.test(t)) { if (out.length) break; else continue; }
    out.push(t);
  }
  return out.join(' ');
}

function outlinkTargets(body) {
  const ids = new Set(), files = new Set();
  let m;
  const wl = /\[\[([^\]|#]+)/g;
  while ((m = wl.exec(body ?? ''))) ids.add(m[1].trim());
  const md = /\]\(([^)\s]+\.md)[^)]*\)/g;
  while ((m = md.exec(body ?? ''))) files.add(basename(m[1].trim()));
  return { ids, files };
}

export function derivePagesMeta(pages) {
  const meta = {};
  const byId = {};
  for (const pg of pages) {
    const key = basename(pg.path);
    const fm = pg.frontmatter ?? {};
    meta[key] = {
      title: fm.title ?? '', type: fm.type ?? '',
      tags: Array.isArray(fm.tags) ? fm.tags.join(', ') : (fm.tags ?? ''),
      source: fm.source ?? '', compiled: fm.compiled ?? '', conflictSince: fm['conflict-since'] ?? '',
      summary: firstParagraph(pg.body), outlinks: [], backlinks: [], orphan: false,
    };
    if (fm.id) byId[fm.id] = key;
  }
  for (const pg of pages) {
    const key = basename(pg.path);
    const { ids, files } = outlinkTargets(pg.body);
    const resolved = new Set();
    const dangling = [];
    for (const id of ids) { if (byId[id]) resolved.add(byId[id]); else dangling.push(id); }
    for (const f of files) { if (meta[f]) resolved.add(f); else dangling.push(f); }
    meta[key].outlinks = [...resolved, ...dangling];
    for (const t of resolved) if (t !== key) meta[t].backlinks.push(key);
  }
  for (const key of Object.keys(meta)) {
    meta[key].orphan = meta[key].outlinks.length === 0 && meta[key].backlinks.length === 0;
  }
  return meta;
}

function walkMd(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walkMd(abs, acc);
    else if (e.name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

export function createPwikiAdapter({ paths, emit }) {
  let snap = new Map(); // absPath -> { conflict:boolean, raw:boolean }
  let watchers = [];
  let lastIndexMtime = null;
  let pagesMeta = {};

  function indexMtime() {
    try { return statSync(paths.wikiIndexJson).mtimeMs; } catch { return null; }
  }

  function refreshIndex() {
    const r = safeRead(paths.wikiIndexJson, (s) => s);
    if (!r.ok) return;                       // missing/unreadable -> keep prior
    if (!r.value.endsWith('\n')) return;     // torn write (bundle ends with \n) -> keep prior
    let bundle;
    try { bundle = JSON.parse(r.value); } catch { return; } // invalid -> keep prior
    if (bundle && Array.isArray(bundle.pages)) pagesMeta = derivePagesMeta(bundle.pages);
  }

  function checkReindex() {
    const m = indexMtime();
    if (m === null) return;                                   // no index.json
    if (lastIndexMtime === null) { lastIndexMtime = m; refreshIndex(); return; } // first observation -> seed, no emit
    if (m !== lastIndexMtime) {
      lastIndexMtime = m;
      refreshIndex();
      emit(makeEvent('p-wiki', 'wiki.reindex', 'index.json', 'index regenerated', {}));
    }
  }

  function scan() {
    const map = new Map();
    for (const f of walkMd(paths.wikiPagesDir)) {
      const r = safeRead(f, readFrontmatter);
      map.set(f, { conflict: r.ok ? !!r.value['conflict-since'] : false, raw: false });
    }
    for (const f of walkMd(paths.wikiRawDir)) map.set(f, { conflict: false, raw: true });
    return map;
  }

  function scanNow() {
    const next = scan();
    for (const [f, meta] of next) {
      const prev = snap.get(f);
      if (!prev) emit(makeEvent('p-wiki', meta.raw ? 'raw.ingested' : 'page.compiled', basename(f), meta.raw ? 'ingested' : 'compiled', {}));
      else if (meta.conflict && !prev.conflict) emit(makeEvent('p-wiki', 'wiki.conflict', basename(f), 'conflict flagged', {}));
      else if (!prev.raw && !meta.raw && prev.conflict === meta.conflict) { /* unchanged flag */ }
    }
    for (const f of snap.keys()) if (!next.has(f)) emit(makeEvent('p-wiki', 'page.removed', basename(f), 'removed', {}));
    snap = next;
  }

  return {
    _scanNow: scanNow, // test seam
    _checkReindex: checkReindex, // test seam
    enabled() {
      const r = safeRead(paths.pwikiConfig, JSON.parse);
      if (r.ok && r.value.primary === 'confluence') {
        // Enabled only if a mirror resolves to an fs-kind destination, not by name.
        const dests = r.value.destinations ?? {};
        const hasFsMirror = Array.isArray(r.value.mirrors) &&
          r.value.mirrors.some((m) => (dests[m]?.kind ?? (m === 'fs' ? 'fs' : undefined)) === 'fs');
        return hasFsMirror;
      }
      return true;
    },
    backfill() { snap = scan(); lastIndexMtime = indexMtime(); refreshIndex(); },
    start() {
      if (existsSync(paths.wikiPagesDir)) watchers.push(watchPath(paths.wikiPagesDir, scanNow));
      if (existsSync(paths.wikiRawDir)) watchers.push(watchPath(paths.wikiRawDir, scanNow));
      if (existsSync(paths.wikiDir)) {
        if (lastIndexMtime === null) lastIndexMtime = indexMtime();
        watchers.push(watchPath(paths.wikiDir, checkReindex));
      }
    },
    stop() { for (const w of watchers) w.close(); watchers = []; },
    status() {
      let pages = 0, raw = 0, conflicts = 0;
      for (const meta of snap.values()) { if (meta.raw) raw++; else { pages++; if (meta.conflict) conflicts++; } }
      return { pages, raw, conflicts, pagesMeta };
    },
  };
}
