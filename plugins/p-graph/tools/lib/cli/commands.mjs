import { indexFull, indexChanged, gitChangedFiles, headSha } from '../index/build.mjs';
import { ensureFresh, computeActionable, driftCount } from '../freshness.mjs';

// A query on an erased graph cannot answer, so it must not look like it did.
// Exit code, so a script can branch on it without reading any text.
const ERASED_EXIT = 4;
const ERASED_MSG = 'the graph was erased by a schema upgrade and was not rebuilt, '
  + 'because auto-refresh is off (--stale-ok or PGRAPH_AUTOREFRESH=0). '
  + 'It holds nothing, so this query cannot answer. Run: pgraph index --full';

export async function runCommand(ctx) {
  const fresh = await ensureFresh(ctx); // no-op for non-query commands; refreshes a stale graph before a query
  const { command, opts, root, store, ignorePatterns, out, emitJson, die } = ctx;

  // Every query would return zero rows AND zero gaps here — byte-identical to a
  // true "nothing calls this" answer, and a banner on stderr is invisible to a
  // --json consumer. Refuse in both modes instead: a JSON body that carries only
  // an error, and a non-zero exit for both modes.
  if (fresh?.erased) {
    if (opts.json) emitJson({ error: 'graph_erased', message: ERASED_MSG });
    return die(ERASED_MSG, ERASED_EXIT);
  }

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
    // Only files a refresh would actually reparse count as drift — the same
    // filter ensureFresh uses. Raw git output also lists files the index
    // never reads (a doc edit) and .pgraph/ itself, untracked right after
    // `index --full` creates it, which used to read as permanent drift.
    st.drift = change ? driftCount(computeActionable(change, ignorePatterns)) : null;
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

  // A guessed row is not wrong, just unverified: the graph could not see the
  // receiver's real type, so it fell back to the one repo symbol that shares
  // the call's bare method name. That symbol might be the right one, or the
  // call might belong to a different type that happens to have a method with
  // the same name. Print certain rows as the answer; print guessed rows apart,
  // under a heading that says why they are unsure.
  // `indent` lets context reuse this exact split under its own "callers:" /
  // "callees:" headers, so callers and context can never disagree about the
  // same symbol — they run the same code, not two copies of the same rule.
  const printCertainThenGuessed = (rows, noun, indent = '') => {
    const certain = rows.filter((r) => !r.guess);
    const guessed = rows.filter((r) => r.guess);
    certain.forEach((r) => out(indent + fmtNode(r)));
    if (guessed.length) {
      const s = guessed.length === 1 ? '' : 's';
      // "more" only makes sense on top of a certain list above it — with none,
      // say what these rows ARE, not that there is "more" of nothing.
      const lead = certain.length ? `${guessed.length} more ${noun}${s}` : `${guessed.length} ${noun}${s}`;
      // "UNVERIFIED", not ⚠: this row is present but may name the wrong
      // symbol, a different claim from ⚠'s meaning everywhere else in this
      // tool (a drift banner, the unattributed-call banner, the gap heading
      // below) — rows that are missing or incomplete, not rows that might be
      // wrong. Two different claims should not share one glyph.
      out(`${indent}UNVERIFIED: ${lead}, matched by name only (guess) — the graph could not see the receiver's type, so ${guessed.length === 1 ? 'this one' : 'these'} may be a different symbol with the same method name:`);
      guessed.forEach((r) => out(indent + '    ' + fmtNode(r)));
    }
  };

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
      // Not every row here truly left the repo: a Go conversion into a repo
      // type (`Duration(v)`), or a call into a repo package that produced no
      // indexed symbols, land here too. Say what is actually true — the graph
      // found nothing to link the call to — instead of claiming it left.
      out(`${lead}${external} call${external === 1 ? '' : 's'} the graph found nothing to link to (stdlib, third party, builtins, or a repo call it never indexed).`);
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
    printCertainThenGuessed(rows, 'caller');
    return emitGaps(gaps);
  }
  if (command === 'callees') {
    const target = opts._[0];
    const rows = store.callees(target), gaps = store.gapsFrom(target);
    if (opts.json) return emitJson({ callees: rows, gaps });
    printCertainThenGuessed(rows, 'callee');
    return emitGaps(gaps);
  }
  if (command === 'impact') {
    const target = opts._[0];
    // The frontier, not just the target: an impact walk also stops at an
    // unattributed call to something it already reached.
    const rows = store.impact(target), gaps = store.gapsAround(target);
    // How many guessed edges the walk refused to follow for THIS target. An
    // empty `impact` means one of two different things: nothing depends on
    // this symbol, or the only paths in were guesses. skipped_guesses is what
    // tells them apart — a count, not a flag, so a caller can also tell
    // "one near-miss" from "several refused".
    const skippedGuesses = store.impactSkippedGuesses(target);
    if (opts.json) return emitJson({ impact: rows, gaps, skipped_guesses: skippedGuesses });
    rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no impact)');
    // Only say this when it is actually true for this query — with no guess
    // anywhere near the target, the line would always print and never mean
    // anything.
    if (skippedGuesses) {
      const s = skippedGuesses === 1 ? '' : 's';
      const be = skippedGuesses === 1 ? 'was' : 'were';
      out(`${skippedGuesses} guessed edge${s} (receiver type unknown) near this target ${be} not followed, so a real impact through one may be missing.`);
    }
    return emitGaps(gaps);
  }
  if (command === 'trace') {
    const found = store.trace(opts._[0], opts._[1]);
    const st = store.status();
    const guessedHops = found ? found.guessed.filter(Boolean).length : 0;
    if (opts.json) {
      // `certain` and `guessed_hops` are null with no path: there are no hops to
      // be sure or unsure about, and false would read as "the path is a guess".
      return emitJson({
        path: found?.path ?? null,
        guessed_hops: found?.guessed ?? null,
        certain: found ? guessedHops === 0 : null,
        unresolved_calls: st.unresolved_calls, call_edges: st.call_edges,
      });
    }
    if (found) {
      // Mark the ARROW, because a guess is a fact about the step, not about
      // either symbol: the symbols on both sides are really in the graph.
      out(found.path
        .map((q, i) => (i === 0 ? q : `${found.guessed[i - 1] ? '-(guess)->' : '->'} ${q}`))
        .join(' '));
      if (guessedHops) {
        out(`UNVERIFIED: ${guessedHops} of ${found.guessed.length} hop${found.guessed.length === 1 ? '' : 's'} matched by name only (guess) — the graph could not see the receiver's type there, so this path may not be real.`);
      }
      return;
    }
    // A missing path is not proof there is none: any unattributed call site
    // could be the hop the walk needed.
    return out(st.unresolved_calls
      ? `(no path — but ${st.unresolved_calls}/${st.call_edges} call sites are unattributed, so a real path may be invisible to the graph)`
      : '(no path)');
  }
  if (command === 'context') {
    const n = store.node(opts._[0]); if (!n) die('symbol not found', 1);
    const gapsIn = store.gapsFor(opts._[0]);
    const gapsOut = store.gapsFrom(opts._[0]);
    // A call from X whose bare name matches X's own name (wrapper delegation,
    // e.g. Counter.Write calling a field's Write) shows up in BOTH gapsIn (it
    // names the target) and gapsOut (X itself made the call). Dedupe on the
    // call site, not the direction, so it is reported once.
    const seen = new Set();
    const gaps = [...gapsIn, ...gapsOut].filter((r) => {
      const key = `${r.file}|${r.line}|${r.dst_name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const ctxObj = {
      node: n, callers: store.callers(opts._[0]), callees: store.callees(opts._[0]),
      gaps_in: gapsIn, gaps_out: gapsOut, gaps,
    };
    if (opts.json) return emitJson(ctxObj);
    out(fmtNode(n));
    // Same split as `callers`/`callees`, run through the same function, so a
    // possibly-wrong row can never show up here unmarked and mixed in with
    // certain ones while `callers` on the same symbol keeps it apart.
    out('callers:'); printCertainThenGuessed(ctxObj.callers, 'caller', '  ');
    out('callees:'); printCertainThenGuessed(ctxObj.callees, 'callee', '  ');
    return emitGaps(gaps);
  }
  if (command === 'explore') {
    const rows = opts._.map((q) => store.node(q)).filter(Boolean);
    return opts.json ? emitJson(rows) : rows.forEach((r) => { out(fmtNode(r)); });
  }

  die(`not implemented: ${command}`, 3);
}
