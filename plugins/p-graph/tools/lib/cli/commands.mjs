import { indexFull, indexChanged, gitChangedFiles, headSha } from '../index/build.mjs';
import { ensureFresh } from '../freshness.mjs';

export async function runCommand(ctx) {
  await ensureFresh(ctx); // no-op for non-query commands; refreshes a stale graph before a query
  const { command, opts, root, store, ignorePatterns, out, emitJson, die } = ctx;

  if (command === 'index') {
    const res = opts.full
      ? await indexFull({ root, store, ignorePatterns })
      : await indexChanged({ root, store, ignorePatterns });
    const sha = headSha(root);
    if (sha) store.setMeta('indexed_sha', sha);
    if (opts.json) return emitJson({ ok: true, ...res, indexed_sha: sha });
    // Summary line, then name any file that threw or produced zero nodes so a
    // whole-file extraction drop is visible instead of hiding inside `skipped`.
    const { errored = [], zeroNode = [], ...counts } = res;
    out(`indexed: ${JSON.stringify(counts)}`);
    if (errored.length) {
      out(`errored (${errored.length}) — dropped from the graph:`);
      errored.forEach((e) => out(`  ${e.file}: ${e.error}`));
    }
    if (zeroNode.length) {
      out(`zero nodes (${zeroNode.length}) — indexed but produced no symbols:`);
      zeroNode.forEach((f) => out(`  ${f}`));
    }
    return;
  }

  if (command === 'status') {
    const st = store.status();
    const change = gitChangedFiles(root, st.indexed_sha);
    st.drift = change ? change.modified.length + change.deleted.length : null;
    return opts.json ? emitJson(st)
      : out(`schema ${st.schema_version} - ${st.nodes} nodes - ${st.edges} edges - ${st.files} files - sha ${st.indexed_sha ?? '-'} - fts ${st.fts} - drift ${st.drift ?? 'n/a'} - unattributed calls ${st.unresolved_calls}/${st.call_edges}`);
  }

  const fmtNode = (n) => `${n.kind} ${n.qname}  ${n.file}:${n.start_line}  ${n.signature}`;

  // Name the call sites pgraph could not attribute to a symbol, so a short
  // answer is never mistaken for a complete one. Queries walk resolved edges
  // only: without this banner "no callers" and "I gave up here" print the same.
  const GAP_LIMIT = 20;
  const emitGaps = (rows) => {
    if (!rows.length) return;
    out(`⚠ ${rows.length} unattributed call site${rows.length === 1 ? '' : 's'} — this answer may be incomplete:`);
    for (const r of rows.slice(0, GAP_LIMIT)) {
      out(`    ${r.file}:${r.line}  ${r.src_qname ?? '(file scope)'} -> ${r.dst_name}`);
    }
    if (rows.length > GAP_LIMIT) out(`    … and ${rows.length - GAP_LIMIT} more`);
    out('  The graph could not tell which symbol these call. Confirm with a text search before treating this answer as complete.');
  };

  if (command === 'search') {
    const q = opts._[0]; if (!q) die('search needs a query');
    const rows = store.search(q, { kind: opts.kind, lang: opts.lang });
    return opts.json ? emitJson(rows) : (rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no matches)'));
  }
  if (command === 'node') {
    const n = store.node(opts._[0]); if (!n) die('symbol not found', 1);
    return opts.json ? emitJson(n) : out(fmtNode(n));
  }
  if (command === 'files') {
    const rows = store.files(opts._[0] ?? '');
    return opts.json ? emitJson(rows) : rows.forEach((r) => out(`${r.path}  (${r.symbols})`));
  }

  if (command === 'callers') {
    const target = opts._[0];
    const rows = store.callers(target), unresolved = store.gapsFor(target);
    if (opts.json) return emitJson({ callers: rows, unresolved });
    rows.forEach((r) => out(fmtNode(r)));
    return emitGaps(unresolved);
  }
  if (command === 'callees') {
    const target = opts._[0];
    const rows = store.callees(target);
    // The source of every gap here IS the symbol asked about — label it, so the
    // banner reads the same way as it does for callers.
    const unresolved = store.gapsFrom(target).map((r) => ({ ...r, src_qname: target }));
    if (opts.json) return emitJson({ callees: rows, unresolved });
    rows.forEach((r) => out(fmtNode(r)));
    return emitGaps(unresolved);
  }
  if (command === 'impact') {
    const target = opts._[0];
    // The frontier, not just the target: an impact walk also stops at an
    // unattributed call to something it already reached.
    const rows = store.impact(target), unresolved = store.gapsAround(target);
    if (opts.json) return emitJson({ impact: rows, unresolved });
    rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no impact)');
    return emitGaps(unresolved);
  }
  if (command === 'trace') {
    const path = store.trace(opts._[0], opts._[1]);
    const st = store.status();
    if (opts.json) return emitJson({ path, unresolved_calls: st.unresolved_calls, call_edges: st.call_edges });
    if (path) return out(path.join(' -> '));
    // A missing path is not proof there is none: any unattributed call site
    // could be the hop the walk needed.
    return out(st.unresolved_calls
      ? `(no path — but ${st.unresolved_calls}/${st.call_edges} call sites are unattributed, so a real path may be invisible to the graph)`
      : '(no path)');
  }
  if (command === 'context') {
    const n = store.node(opts._[0]); if (!n) die('symbol not found', 1);
    const ctxObj = {
      node: n, callers: store.callers(opts._[0]), callees: store.callees(opts._[0]),
      unresolved_in: store.gapsFor(opts._[0]),
      unresolved_out: store.gapsFrom(opts._[0]).map((r) => ({ ...r, src_qname: n.qname })),
    };
    if (opts.json) return emitJson(ctxObj);
    out(fmtNode(n));
    out('callers:'); ctxObj.callers.forEach((r) => out('  ' + fmtNode(r)));
    out('callees:'); ctxObj.callees.forEach((r) => out('  ' + fmtNode(r)));
    return emitGaps([...ctxObj.unresolved_in, ...ctxObj.unresolved_out]);
  }
  if (command === 'explore') {
    const rows = opts._.map((q) => store.node(q)).filter(Boolean);
    return opts.json ? emitJson(rows) : rows.forEach((r) => { out(fmtNode(r)); });
  }

  die(`not implemented: ${command}`, 3);
}
