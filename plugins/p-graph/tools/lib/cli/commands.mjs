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

  // A forgotten argument used to travel all the way into SQLite as an unbound
  // parameter, so a typo answered with `Provided value cannot be bound to SQLite
  // parameter 1.` and exit 3. Say which argument is missing, like `search` does.
  const needArg = (what) => {
    const v = opts._[0];
    if (v === undefined) die(`${command} needs ${what}`);
    return v;
  };

  // The gap report cannot be built on a database older than schema 6 (no
  // dst_bare column). That is not "no gaps" — say so, or the rows above read as
  // the whole truth.
  const GAPS_UNAVAILABLE = 'the gap report needs a rebuilt graph (this one predates schema 7), '
    + 'so call sites missing from this answer are NOT listed. Run: pgraph index --full';
  const gapsOff = Boolean(store.gapsUnavailable);
  const noteGapsOff = () => { if (gapsOff) out(`⚠ ${GAPS_UNAVAILABLE}`); };

  // A caller row answers "where is the call written", so that is what it shows.
  // It used to show where the CALLER was declared, plus its signature — up to
  // 300 characters of row for a fact nobody asked for, and none of the call
  // lines. `pgraph node <qname>` still prints the signature, and so does
  // `search`. Repeated files are written once: `a.go:10, 11`.
  //
  // A file row (a call written outside any symbol) carries the path as its NAME,
  // so `${n.kind} ${n.qname}` has already printed it. Seeding `last` with that
  // path lets the same "repeated file written once" rule drop it from the sites
  // too: `file app/boot.js  3, 4`, not `file app/boot.js  app/boot.js:3, 4`.
  // It is also why such a row never falls back to `file:line` — a file has no
  // declaration line, and `app/boot.js:null` would read as a place to open.
  const fmtSites = (n) => {
    const own = n.kind === 'file' ? n.qname : null;
    if (!n.call_sites?.length) return own ?? `${n.file}:${n.start_line}`;
    let last = own;
    return n.call_sites.map((s) => {
      const out = s.file === last ? String(s.line) : `${s.file}:${s.line}`;
      last = s.file;
      return out;
    }).join(', ');
  };
  const fmtCall = (n) => `${n.kind} ${n.qname}  ${fmtSites(n)}`;

  // A declaration row: where the symbol is written, and its signature. `impact`
  // prints these, and `impact` now also returns file rows — a call written
  // outside any symbol. A file has no declaration line and no signature, so this
  // template would read `file app/boot.js  app/boot.js:null  null`: two nulls
  // dressed up as a place the reader could open. What such a row carries is its
  // call sites, so print those, in the same words `callers` uses for the same
  // row: `file app/boot.js  3, 4`. Kept in this one formatter, so no caller of it
  // needs to know about the case.
  const fmtNode = (n) => (n.kind === 'file'
    ? fmtCall(n)
    : `${n.kind} ${n.qname}  ${n.file}:${n.start_line}  ${n.signature}`);

  // `callers Get` merges every symbol named Get, and used to do it in silence —
  // so a reader ran `search Get` first just to learn what they had asked about.
  // Saying it here turns two commands into one.
  // Nothing in the graph carries this name. Say so, and say it in words that
  // cannot be read as an answer: an empty list plus "✓ complete" is what
  // `callers "RE2::Match"` printed on re2 while knowing nothing about the
  // symbol at all — the most confident wrong answer this tool can give.
  const noSuchSymbol = (name) =>
    `no symbol named ${name} in the graph — nothing to report. Try \`pgraph search ${name}\`.`;

  const emitTargets = (name) => {
    const t = store.symbolsNamed(name);
    if (!t.length) { out(noSuchSymbol(name)); return t; }
    if (t.length === 1) out(`target: ${t[0].kind} ${t[0].qname}  ${t[0].file}:${t[0].start_line}`);
    else {
      out(`target: ${t.length} symbols named ${t[0].name} — the rows below merge all of them.`);
      // A TypeScript or Python qname carries no module path, so a monorepo can hold
      // the same qname several times over. Repeating it then reads as advice —
      // "ask by qname to separate: RecipesService.findOneById,
      // RecipesService.findOneById, RecipesService.findOneById" — that cannot be
      // followed. When the qnames do not tell the symbols apart, the file and line
      // do. Measured on nest: 393 qnames are carried by more than one symbol.
      const qnames = [...new Set(t.map((x) => x.qname))];
      if (qnames.length === t.length) out(`  Ask by qname to separate: ${qnames.join(', ')}`);
      else out(`  They share a qname; tell them apart by file: ${
        t.map((x) => `${x.file}:${x.start_line}`).join(', ')}`);
    }
    return t;
  };

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
    certain.forEach((r) => out(indent + fmtCall(r)));
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
      guessed.forEach((r) => out(indent + '    ' + fmtCall(r)));
    }
  };

  // Name the call sites this answer is missing, without burying them. A gap that
  // shares a name with the target but sits in a file that cannot even see the
  // target's package is almost always a coincidence, and a call that leaves the
  // repo can never be linked — both are counted honestly and not listed, because
  // a banner nobody reads is worse than none.
  const GAP_LIMIT = 20;
  // The three groups the gap report splits into. Pulled out so the completeness
  // line below is decided by exactly the same rule that decides whether a
  // banner prints — the two can never disagree about one answer.
  // `interface` rows are pulled out first and counted with none of the three: they
  // are not a gap. The other groups all mean "the graph could not account for this
  // line"; an interface row means the opposite — the graph accounted for the call
  // and knows exactly which interface carries it. Putting it under the ⚠ banner
  // would tell the reader to grep for something a text search cannot find at all.
  // `library` rows are counted apart for the same reason `unrelated` ones are: the
  // graph can PROVE they are not the target, because the source writes the
  // receiver's type and it belongs to a library. Listing them sends the reader to
  // grep for something that is already settled. They still block ✓ complete and
  // still print a count, because a refused call must never disappear.
  const gapCounts = (rows) => ({
    viaInterface: rows.filter((r) => r.reason === 'interface'),
    viaImplementation: rows.filter((r) => r.reason === 'implementation'),
    listed: rows.filter((r) => r.reason !== 'external' && r.reason !== 'interface'
      && r.reason !== 'implementation' && r.reason !== 'library' && r.reachable !== 0),
    unrelated: rows.filter((r) => r.reason === 'ambiguous' && r.reachable === 0).length,
    library: rows.filter((r) => r.reason === 'library').length,
    external: rows.filter((r) => r.reason === 'external').length,
  });
  const nothingMissing = (rows) => {
    const c = gapCounts(rows);
    return !c.listed.length && !c.unrelated && !c.external && !c.library;
  };
  // An answer with nothing missing used to end in silence, and silence reads as
  // "I do not know" — measured on seven public repos, an agent given a gap-free
  // answer went and grepped anyway in 12 runs out of 12. So say it. The claim is
  // deliberately narrow: what the graph FOUND, not a promise about a file it
  // failed to parse. See docs/measured-benefit.md.
  // Deliberately shares no wording with the ⚠ banner. The two make opposite
  // claims, and `not.toContain('missing from this answer')` is how more than one
  // test — and, more importantly, a reader skimming — tells them apart.
  const COMPLETE = '✓ complete — no gaps: the graph accounted for every call site it found.';
  const COMPLETE_IMPACT = '✓ complete — no gaps, and no edge was refused.';
  // The one case where "complete" would be read as "stop" and be wrong. The gap
  // report really is empty, so the claim below is still about gaps only — but
  // when every row above is a guess there is nothing settled to stop on, and the
  // rule's other instruction (open each guess) is the one that applies.
  // Deliberately does NOT contain the word "complete": a reader skims for it.
  // Measured on axios: `callers "AxiosHeaders.has"` printed 18 guesses, no
  // certain row, and `✓ complete`. That run cost 16.7 steps against grep's 9.7
  // and dropped 10 real call sites.
  const NO_GAPS_ALL_GUESSED = '✓ no gaps — but every row above is a guess, so nothing here is settled.'
    + ' Open each one before relying on it.';

  // `complete` is passed in, never derived here: only the caller knows whether
  // its own command left something else out (impact refuses guessed edges), and
  // `gapsOff` means the report could not be built at all — an empty list there
  // is the one case where claiming completeness would be a lie.
  // Were there rows above, and was every one of them a guess? Only then does the
  // completeness line change — a majority rule would need a threshold to defend,
  // and "all of them" is a fact with nothing to argue about.
  const allGuessed = (rows) => rows.length > 0 && rows.every((r) => r.guess);

  // Groups `rows` by `via` and prints one heading per group, followed by its
  // call sites (capped at GAP_LIMIT). `heading(count, via)` builds the full
  // heading line, so the two callers below can each state their own claim in
  // their own words — one says the run-time choice is still open, the other
  // says the graph already knows which method runs — while sharing the one
  // grouping-and-printing loop that used to be copied between them.
  const emitReachGroup = (rows, heading) => {
    if (!rows.length) return;
    const byVia = new Map();
    for (const r of rows) {
      if (!byVia.has(r.via)) byVia.set(r.via, []);
      byVia.get(r.via).push(r);
    }
    for (const [via, rs] of byVia) {
      out(heading(rs.length, via));
      for (const r of rs.slice(0, GAP_LIMIT)) {
        out(`    ${r.file}:${r.line}  ${r.src_qname ?? 'file scope'} -> ${r.dst_name}`);
      }
      if (rs.length > GAP_LIMIT) out(`    … and ${rs.length - GAP_LIMIT} more`);
    }
  };

  const emitGaps = (rows, complete = false, line = COMPLETE) => {
    const { viaInterface, viaImplementation, listed, unrelated, library, external } = gapCounts(rows);
    // Printed before everything else, and grouped by the interface that carries
    // the calls. This is knowledge, not a gap: which implementation runs is decided
    // at run time, and naming the interface is the part a text search cannot do.
    emitReachGroup(viaInterface, (n, via) =>
      `ℹ ${n} ${n === 1 ? 'call site reaches' : 'call sites reach'} this method through ${via}`
      + ' — which implementation runs is decided at run time:');
    // The opposite direction, and it says something different: here the receiver's
    // type IS written at the call site, so the graph knows exactly which method
    // runs. These rows ARE call sites of the method that was asked about — the
    // heading must say so up front, not as an aside, or a reader files them
    // under "adjacent, not the answer" and drops them. Grouped by the
    // implementing method so the reader can also see which type each call
    // belongs to.
    // Measured on caddy: the old heading ("run an implementation of this
    // method — I") is true but reads as a category next to the answer. An
    // agent given it invented its own heading ("not the interface value
    // itself") for all 17 rows, and the extractor then counted 1 of 18 instead
    // of 18 — the same graph data, scored wrong because of the wording alone.
    emitReachGroup(viaImplementation, (n, via) =>
      `ℹ ${n} ${n === 1 ? 'call site' : 'call sites'} of this method — on ${via}, which implements it:`);
    if (!listed.length && !unrelated && !library && !external) return complete ? out(line) : undefined;
    if (listed.length) {
      out(`⚠ ${listed.length} call site${listed.length === 1 ? '' : 's'} missing from this answer:`);
      for (const r of listed.slice(0, GAP_LIMIT)) {
        // `file scope` when the gap row has no enclosing symbol: the call is
        // written outside any function and the graph could not resolve it. A
        // RESOLVED call at file scope is not a gap at all — `callers` and
        // `impact` list it as a `file` row.
        out(`    ${r.file}:${r.line}  ${r.src_qname ?? 'file scope'} -> ${r.dst_name}`);
      }
      if (listed.length > GAP_LIMIT) out(`    … and ${listed.length - GAP_LIMIT} more`);
    }
    // "+" reads as "on top of the list above", so only use it when there is a
    // list above. A count line has to stand on its own too.
    const lead = listed.length ? '  + ' : '  ';
    if (unrelated) {
      out(`${lead}${unrelated} same-name call site${unrelated === 1 ? '' : 's'} in files that do not import the target's package — likely unrelated, not listed.`);
    }
    if (library) {
      out(`${lead}${library} call site${library === 1 ? '' : 's'} whose receiver the source types as a library type — provably not this method, not listed.`);
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
    const n = store.node(needArg('a symbol')); if (!n) die('symbol not found', 1);
    return opts.json ? emitJson(n) : out(fmtNode(n));
  }
  if (command === 'files') {
    const rows = store.files(opts._[0] ?? '');
    return opts.json ? emitJson(rows) : rows.forEach((r) => out(`${r.path}  (${r.symbols})`));
  }

  if (command === 'callers') {
    const target = needArg('a symbol');
    const rows = store.callers(target), gaps = store.gapsFor(target);
    // Completeness is a claim about a symbol. With no symbol there is nothing to
    // be complete about, so an unknown name can never earn the line.
    const known = store.symbolsNamed(target);
    const complete = !gapsOff && known.length > 0 && nothingMissing(gaps);
    // `complete` stays a claim about the GAP report, and that claim is true even
    // here, so it is not corrupted. The new fact gets its own field.
    const guessedOnly = allGuessed(rows);
    if (opts.json) return emitJson({ callers: rows, targets: known, gaps, complete,
      ...(guessedOnly ? { all_guessed: true } : {}),
      ...(gapsOff ? { gaps_unavailable: true } : {}) });
    emitTargets(target);
    printCertainThenGuessed(rows, 'caller');
    noteGapsOff();
    return emitGaps(gaps, complete, guessedOnly ? NO_GAPS_ALL_GUESSED : COMPLETE);
  }
  if (command === 'callees') {
    const target = needArg('a symbol');
    const rows = store.callees(target), gaps = store.gapsFrom(target);
    const known = store.symbolsNamed(target);
    const complete = !gapsOff && known.length > 0 && nothingMissing(gaps);
    const guessedOnly = allGuessed(rows);
    if (opts.json) return emitJson({ callees: rows, targets: known, gaps, complete,
      ...(guessedOnly ? { all_guessed: true } : {}),
      ...(gapsOff ? { gaps_unavailable: true } : {}) });
    emitTargets(target);
    printCertainThenGuessed(rows, 'callee');
    noteGapsOff();
    return emitGaps(gaps, complete, guessedOnly ? NO_GAPS_ALL_GUESSED : COMPLETE);
  }
  if (command === 'impact') {
    const target = needArg('a symbol');
    // The frontier, not just the target: an impact walk also stops at an
    // unattributed call to something it already reached.
    const rows = store.impact(target), gaps = store.gapsAround(target);
    // How many guessed edges the walk refused to follow for THIS target. An
    // empty `impact` means one of two different things: nothing depends on
    // this symbol, or the only paths in were guesses. skipped_guesses is what
    // tells them apart — a count, not a flag, so a caller can also tell
    // "one near-miss" from "several refused".
    const skippedGuesses = store.impactSkippedGuesses(target);
    // An impact answer is a floor, not a ceiling: refusing one guessed edge
    // leaves a real dependency out even when the gap list is empty. So a
    // refusal disqualifies the completeness claim on its own — and so does a
    // name no symbol carries, for the reason on noSuchSymbol.
    const known = store.symbolsNamed(target);
    const complete = !gapsOff && known.length > 0 && skippedGuesses === 0 && nothingMissing(gaps);
    if (opts.json) return emitJson({ impact: rows, gaps, skipped_guesses: skippedGuesses, complete,
      ...(gapsOff ? { gaps_unavailable: true } : {}) });
    if (!known.length) out(noSuchSymbol(target));
    rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no impact)');
    // Only say this when it is actually true for this query — with no guess
    // anywhere near the target, the line would always print and never mean
    // anything.
    noteGapsOff();
    if (skippedGuesses) {
      const s = skippedGuesses === 1 ? '' : 's';
      const be = skippedGuesses === 1 ? 'was' : 'were';
      out(`${skippedGuesses} guessed edge${s} (receiver type unknown) near this target ${be} not followed, so a real impact through one may be missing.`);
    }
    return emitGaps(gaps, complete, COMPLETE_IMPACT);
  }
  if (command === 'trace') {
    if (opts._[0] === undefined || opts._[1] === undefined) die('trace needs two symbols');
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
    const n = store.node(needArg('a symbol')); if (!n) die('symbol not found', 1);
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
    const complete = !gapsOff && nothingMissing(gaps);
    const ctxObj = {
      node: n, callers: store.callers(opts._[0]), callees: store.callees(opts._[0]),
      gaps_in: gapsIn, gaps_out: gapsOut, gaps, complete,
    };
    if (opts.json) return emitJson(gapsOff ? { ...ctxObj, gaps_unavailable: true } : ctxObj);
    out(fmtNode(n));
    // Same split as `callers`/`callees`, run through the same function, so a
    // possibly-wrong row can never show up here unmarked and mixed in with
    // certain ones while `callers` on the same symbol keeps it apart.
    out('callers:'); printCertainThenGuessed(ctxObj.callers, 'caller', '  ');
    out('callees:'); printCertainThenGuessed(ctxObj.callees, 'callee', '  ');
    noteGapsOff();
    return emitGaps(gaps, complete);
  }
  if (command === 'explore') {
    const rows = opts._.map((q) => store.node(q)).filter(Boolean);
    return opts.json ? emitJson(rows) : rows.forEach((r) => { out(fmtNode(r)); });
  }

  die(`not implemented: ${command}`, 3);
}
