const STOPWORDS_EN = new Set('a an and are as at be by for from has he in is it its of on or that the to was were will with'.split(' '));
const STOPWORDS_RU = new Set('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот'.split(' '));

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter(t => !STOPWORDS_EN.has(t) && !STOPWORDS_RU.has(t));
}

export function rankDocuments(query, docs, opts = {}) {
  const limit = opts.limit ?? 10;
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return [];

  const k1 = 1.2;
  const b = 0.75;

  // Document stats
  const docInfos = docs.map(d => {
    const bodyTokens = tokenize(d.body);
    const titleTokens = tokenize(d.frontmatter.title ?? '');
    const tagTokens = (d.frontmatter.tags ?? []).flatMap(t => tokenize(t));
    return { doc: d, bodyTokens, titleTokens, tagTokens, len: bodyTokens.length };
  });
  const avgLen = docInfos.reduce((a, i) => a + i.len, 0) / Math.max(docInfos.length, 1);
  const N = docInfos.length;

  // Term doc-frequency (over body for ranking)
  const df = new Map();
  for (const t of qTerms) {
    df.set(t, docInfos.filter(i => i.bodyTokens.includes(t)).length);
  }

  const results = [];
  for (const info of docInfos) {
    let score = 0;
    let anyMatch = false;
    for (const t of qTerms) {
      const tf = info.bodyTokens.filter(x => x === t).length;
      const dft = df.get(t);
      const titleHit = info.titleTokens.includes(t) ? 1 : 0;
      const tagHit = info.tagTokens.includes(t) ? 1 : 0;
      if (tf === 0 && titleHit === 0 && tagHit === 0) continue;
      anyMatch = true;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      const norm = (k1 + 1) * tf / (tf + k1 * (1 - b + b * info.len / Math.max(avgLen, 1)));
      score += idf * norm + 3 * titleHit + 2 * tagHit;
    }
    if (!anyMatch) continue;
    results.push({
      path: info.doc.path,
      title: info.doc.frontmatter.title ?? '',
      type: info.doc.frontmatter.type ?? '',
      tags: info.doc.frontmatter.tags ?? [],
      score: Number(score.toFixed(2)),
      snippet: opts.snippet === false ? '' : snippetFor(info.doc.body, qTerms),
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippetFor(body, terms) {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const at = lower.indexOf(t);
    if (at >= 0 && (idx === -1 || at < idx)) idx = at;
  }
  if (idx < 0) return body.slice(0, 80).replace(/\s+/g, ' ').trim() + '...';
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + 80);
  return '...' + body.slice(start, end).replace(/\s+/g, ' ').trim() + '...';
}
