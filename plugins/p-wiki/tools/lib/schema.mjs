export const TYPES = [
  'concept', 'person', 'source', 'query',
  'raw-article', 'raw-file', 'raw-paste',
];

const BASE_PAGE = ['id', 'type', 'title', 'created', 'updated', 'status', 'tags', 'sources'];
const BASE_ALLOWED = [...BASE_PAGE, 'conflict-since'];
const QUERY_FIELDS = ['id', 'type', 'title', 'created', 'status', 'tags', 'question', 'informed-by'];
const RAW_FIELDS = ['id', 'type', 'title', 'source-url', 'source-type', 'ingested', 'compiled', 'compiled-to'];

const TYPE_SCHEMAS = {
  concept: { required: BASE_PAGE, allowed: BASE_ALLOWED },
  person: { required: BASE_PAGE, allowed: BASE_ALLOWED },
  source: {
    required: [...BASE_PAGE, 'source-url', 'source-type'],
    allowed: [...BASE_ALLOWED, 'source-url', 'source-type'],
  },
  query: { required: QUERY_FIELDS, allowed: [...QUERY_FIELDS, 'updated', 'conflict-since'] },
  'raw-article': { required: RAW_FIELDS, allowed: RAW_FIELDS },
  'raw-file': { required: RAW_FIELDS, allowed: RAW_FIELDS },
  'raw-paste': { required: RAW_FIELDS, allowed: RAW_FIELDS },
};

const SOURCE_TYPES = ['article', 'paper', 'transcript', 'code', 'doc'];

export function requiredFields(type) {
  return TYPE_SCHEMAS[type]?.required ?? [];
}

export function allowedFields(type) {
  return TYPE_SCHEMAS[type]?.allowed ?? [];
}

export function validateFrontmatter(fm) {
  const t = fm.type;
  if (!TYPES.includes(t)) return { ok: false, error: `unknown type: ${t}` };
  const required = TYPE_SCHEMAS[t].required;
  for (const f of required) {
    if (!(f in fm)) return { ok: false, error: `missing required field: ${f}` };
  }
  if (t === 'raw-paste' && fm['source-type'] !== 'doc') {
    return { ok: false, error: `raw-paste must have source-type=doc` };
  }
  if ('source-type' in fm && !SOURCE_TYPES.includes(fm['source-type'])) {
    return { ok: false, error: `invalid source-type: ${fm['source-type']}` };
  }
  if ('conflict-since' in fm && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm['conflict-since']))) {
    return { ok: false, error: `conflict-since must be YYYY-MM-DD: ${fm['conflict-since']}` };
  }
  return { ok: true };
}

export function templateBody(type, ctx) {
  const title = ctx.title ?? '<title>';
  switch (type) {
    case 'concept':
    case 'person':
      return `\n# ${title}\n\nDefinition in 1–2 sentences.\n\n## Key facts\n- \n\n## Related concepts\n- \n\n## Sources\nSee \`sources:\` in frontmatter.\n`;
    case 'source':
      return `\n# Summary: ${title}\n\n## Main ideas\n- \n\n## Extracted concepts\n- \n`;
    case 'query':
      return `\n# ${title}\n\n**Q:** ${ctx.question ?? ''}\n\n**A:** \n\n## Based on\n- \n`;
    case 'raw-article':
    case 'raw-file':
    case 'raw-paste':
      return `\n# ${title}\n\n${ctx.body ?? ''}\n`;
  }
  return `\n# ${title}\n`;
}

export function isRawType(type) {
  return type.startsWith('raw-');
}

export function directoryFor(type) {
  // type 'query' lives in 'queries/' (plural per spec §3 lint)
  if (type === 'query') return 'pages/queries';
  if (isRawType(type)) {
    if (type === 'raw-article') return 'raw/articles';
    if (type === 'raw-file') return 'raw/files';
    if (type === 'raw-paste') return 'raw/pastes';
  }
  return `pages/${type}`;
}
