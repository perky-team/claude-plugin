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
    // status never calls ensureFresh, but openStore already dropped the graph
    // tables on a schema upgrade — say so, or "0 nodes" reads like an empty
    // repo instead of a rebuild waiting on the next query.
    const schemaStale = store.schemaStale?.() ?? false;
    st.schema_stale = schemaStale;
    if (opts.json) return emitJson(st);
    const hint = schemaStale ? ' - rebuild pending (schema upgrade)' : '';
    return out(`schema ${st.schema_version} - ${st.nodes} nodes - ${st.edges} edges - ${st.files} files - sha ${st.indexed_sha ?? '-'} - fts ${st.fts} - drift ${st.drift ?? 'n/a'} - unattributed calls ${st.unresolved_calls}/${st.call_edges}${hint}`);
  }

  const fmtNode = (n) => `${n.kind} ${n.qname}  ${n.file}:${n.start_line}  ${n.signature}`;

  // Name the call sites this answer is missing, without burying them. A gap that
  // shares a name with the target but sits in a file that cannot even see the
  // target's package is almost always a coincidence, and a call that leaves the
  // repo can never be linked — both are counted honestly and not listed, because
  // a banner nobody reads is worse than none.
  const GAP_LIMIT = 20;
  const emitGaps = (rows) => {
    const listed = rows.filter((r) => r.reason !== 'external' && r.reachable !== 0);
    const unrelated = rows.filter((r) => r.reason === 'ambiguous' && r.reachable === 0).length;
    const external = rows.filter((r) => r.reason === 'external').length;
    if (!listed.length && !unrelated && !external) return;
    if (listed.length) {
      out(`⚠ ${listed.length} call site${listed.length === 1 ? '' : 's'} missing from this answer:`);
      for (const r of listed.slice(0, GAP_LIMIT)) {
        const where = r.reason === 'no-caller'
          ? 'outside any indexed symbol'
          : (r.src_qname ?? 'file scope');
        out(`    ${r.file}:${r.line}  ${where} -> ${r.dst_name}`);
      }
      if (listed.length > GAP_LIMIT) out(`    … and ${listed.length - GAP_LIMIT} more`);
    }
    // "+" reads as "on top of the list above", so only use it when there is a
    // list above. A count line has to stand on its own too.
    const lead = listed.length ? '  + ' : '  ';
    if (unrelated) {
      out(`${lead}${unrelated} same-name call site${unrelated === 1 ? '' : 's'} in files that do not import the target's package — likely unrelated, not listed.`);
    }
    if (external) {
      out(`${lead}${external} call${external === 1 ? '' : 's'} that leave${external === 1 ? 's' : ''} the repo (stdlib, third party, builtins) — nothing to link.`);
    }
    out('  Confirm with a text search before treating this answer as complete.');
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
    const rows = store.callers(target), gaps = store.gapsFor(target);
    if (opts.json) return emitJson({ callers: rows, gaps });
    rows.forEach((r) => out(fmtNode(r)));
    return emitGaps(gaps);
  }
  if (command === 'callees') {
    const target = opts._[0];
    const rows = store.callees(target), gaps = store.gapsFrom(target);
    if (opts.json) return emitJson({ callees: rows, gaps });
    rows.forEach((r) => out(fmtNode(r)));
    return emitGaps(gaps);
  }
  if (command === 'impact') {
    const target = opts._[0];
    // The frontier, not just the target: an impact walk also stops at an
    // unattributed call to something it already reached.
    const rows = store.impact(target), gaps = store.gapsAround(target);
    if (opts.json) return emitJson({ impact: rows, gaps });
    rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no impact)');
    return emitGaps(gaps);
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
      gaps_in: store.gapsFor(opts._[0]),
      gaps_out: store.gapsFrom(opts._[0]),
    };
    if (opts.json) return emitJson(ctxObj);
    out(fmtNode(n));
    out('callers:'); ctxObj.callers.forEach((r) => out('  ' + fmtNode(r)));
    out('callees:'); ctxObj.callees.forEach((r) => out('  ' + fmtNode(r)));
    return emitGaps([...ctxObj.gaps_in, ...ctxObj.gaps_out]);
  }
  if (command === 'explore') {
    const rows = opts._.map((q) => store.node(q)).filter(Boolean);
    return opts.json ? emitJson(rows) : rows.forEach((r) => { out(fmtNode(r)); });
  }

  die(`not implemented: ${command}`, 3);
}
