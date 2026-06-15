import { execFileSync } from 'node:child_process';
import { indexFull, indexChanged } from '../index/build.mjs';

function headSha(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim(); }
  catch { return null; }
}

export async function runCommand(ctx) {
  const { command, opts, root, store, ignorePatterns, out, emitJson, die } = ctx;

  if (command === 'index') {
    const res = opts.full
      ? await indexFull({ root, store, ignorePatterns })
      : await indexChanged({ root, store, ignorePatterns });
    const sha = headSha(root);
    if (sha) store.setMeta('indexed_sha', sha);
    return opts.json ? emitJson({ ok: true, ...res, indexed_sha: sha }) : out(`indexed: ${JSON.stringify(res)}`);
  }

  if (command === 'status') {
    const st = store.status();
    return opts.json ? emitJson(st)
      : out(`schema ${st.schema_version} - ${st.nodes} nodes - ${st.edges} edges - ${st.files} files - sha ${st.indexed_sha ?? '-'} - fts ${st.fts}`);
  }

  const fmtNode = (n) => `${n.kind} ${n.qname}  ${n.file}:${n.start_line}  ${n.signature}`;

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
    const rows = store.callers(opts._[0]);
    return opts.json ? emitJson(rows) : rows.forEach((r) => out(fmtNode(r)));
  }
  if (command === 'callees') {
    const rows = store.callees(opts._[0]);
    return opts.json ? emitJson(rows) : rows.forEach((r) => out(fmtNode(r)));
  }
  if (command === 'impact') {
    const rows = store.impact(opts._[0]);
    return opts.json ? emitJson(rows) : (rows.length ? rows.forEach((r) => out(fmtNode(r))) : out('(no impact)'));
  }
  if (command === 'trace') {
    const path = store.trace(opts._[0], opts._[1]);
    return opts.json ? emitJson({ path }) : out(path ? path.join(' -> ') : '(no path)');
  }
  if (command === 'context') {
    const n = store.node(opts._[0]); if (!n) die('symbol not found', 1);
    const ctxObj = { node: n, callers: store.callers(opts._[0]), callees: store.callees(opts._[0]) };
    if (opts.json) return emitJson(ctxObj);
    out(fmtNode(n));
    out('callers:'); ctxObj.callers.forEach((r) => out('  ' + fmtNode(r)));
    out('callees:'); ctxObj.callees.forEach((r) => out('  ' + fmtNode(r)));
    return;
  }
  if (command === 'explore') {
    const rows = opts._.map((q) => store.node(q)).filter(Boolean);
    return opts.json ? emitJson(rows) : rows.forEach((r) => { out(fmtNode(r)); });
  }

  die(`not implemented: ${command}`, 3);
}
