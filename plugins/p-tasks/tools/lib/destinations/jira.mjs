import { createHttpClient } from '../jira/http.mjs';
import { createIssue, updateIssueFields, transitionIssue, listIssues } from '../jira/issues.mjs';
import { createBlocksLink, deleteLink, listBlocksLinks } from '../jira/links.mjs';
import { STATUSES } from '../schema.mjs';

function extractAdfText(adf) {
  if (!adf || !adf.content) return '';
  const out = [];
  function walk(node) {
    if (node?.text) out.push(node.text);
    for (const c of node?.content ?? []) walk(c);
  }
  walk(adf);
  return out.join('').trim();
}

function jiraStatusToInternal(name, statusMap) {
  for (const k of STATUSES) if (statusMap[k] === name) return k;
  return 'todo'; // unmapped → conservative default
}

// Jira has no guaranteed custom fields for our work-item metadata, so the
// optional fields are round-tripped as a clearly-delimited block appended to
// the issue description. On read this block is best-effort/opaque: it is split
// off the human description and parsed back when well-formed, but a hand-edited
// or malformed block is simply ignored (the human text is still recovered).
const META_FIELDS = ['acceptance', 'files', 'kind', 'origin', 'resolution'];
const META_START = '----- p-tasks metadata (managed; edit via /p-tasks:set) -----';
const META_END = '----- end p-tasks metadata -----';

function serializeMeta(item) {
  const lines = [];
  for (const k of META_FIELDS) {
    const v = item[k];
    if (v === undefined || v === null) continue;
    if (k === 'files') {
      if (!Array.isArray(v) || v.length === 0) continue;
      lines.push(`${k}: ${v.join(', ')}`);
    } else {
      if (v === '') continue;
      lines.push(`${k}: ${String(v).replace(/\r?\n/g, ' ')}`);
    }
  }
  return lines.length === 0 ? '' : `${META_START}\n${lines.join('\n')}\n${META_END}`;
}

function composeDescription(human, meta) {
  const block = serializeMeta(meta);
  const base = (human ?? '').trim();
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

function splitDescription(text) {
  const t = text ?? '';
  const startIdx = t.indexOf(META_START);
  if (startIdx === -1) return { human: t.trim(), meta: {} };
  const endIdx = t.indexOf(META_END, startIdx);
  const block = endIdx === -1 ? t.slice(startIdx + META_START.length) : t.slice(startIdx + META_START.length, endIdx);
  const meta = {};
  for (const line of block.split('\n')) {
    const m = /^\s*([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (!m || !META_FIELDS.includes(m[1])) continue;
    if (m[1] === 'files') meta.files = m[2].split(',').map(s => s.trim()).filter(Boolean);
    else meta[m[1]] = m[2].trim();
  }
  return { human: t.slice(0, startIdx).trim(), meta };
}

export function createJiraDestination({ block, email, token, transport, name = 'jira' }) {
  const http = createHttpClient({ baseUrl: block.siteUrl, email, token, transport });
  const { projectKey, issueTypes, statusMap, jql } = block;

  function toItem(issue) {
    const it = issue.fields.issuetype?.name;
    const type = it === issueTypes.task ? 'task' : 'sub-task';
    const { human, meta } = splitDescription(extractAdfText(issue.fields.description));
    const base = {
      id: issue.key,
      type,
      title: issue.fields.summary ?? '',
      description: human,
      ...meta,
      status: jiraStatusToInternal(issue.fields.status?.name, statusMap),
      // Jira returns only the opposite end of each link; when this issue is
      // blocked it is the inward side, so its blocker is the link's outwardIssue.
      blockedBy: (issue.fields.issuelinks ?? [])
        .filter(l => l.type?.name === 'Blocks' && l.outwardIssue?.key)
        .map(l => l.outwardIssue.key),
    };
    if (type === 'sub-task') base.parentId = issue.fields.parent?.key;
    return base;
  }

  return {
    kind: 'jira',
    name,

    async ensureStructure() {
      const res = await http.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
      if (res.status !== 200) throw Object.assign(new Error(`project ${projectKey} not accessible`), { status: res.status });
    },

    async listItems() {
      const issues = await listIssues(http, jql || `project = ${projectKey} AND issuetype in ("${issueTypes.task}", "${issueTypes.subTask}")`);
      return issues.map(toItem);
    },

    async readItem(id) {
      const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,description,status,issuetype,parent,issuelinks`);
      if (res.status === 404) throw Object.assign(new Error(`item-not-found: ${id}`), { code: 'item-not-found' });
      if (res.status !== 200) throw Object.assign(new Error(`read failed: ${res.status}`), { status: res.status });
      return toItem({ key: id, ...res.body });
    },

    async createItem(input) {
      const issueType = input.type === 'task' ? issueTypes.task : issueTypes.subTask;
      const out = await createIssue(http, {
        projectKey, issueType,
        summary: input.title,
        // Fold the optional work-item fields into the description as a delimited
        // metadata block (no custom fields assumed).
        description: composeDescription(input.description ?? '', input),
        parentKey: input.type === 'sub-task' ? input.parentId : undefined,
      });
      // Apply non-default status if requested (single-hop only). A workflow
      // with no direct transition to the target must not abort the whole sync —
      // leave the issue in its default status rather than throwing.
      let status = input.status ?? 'todo';
      if (input.status && input.status !== 'todo') {
        try {
          await transitionIssue(http, out.key, statusMap[input.status]);
        } catch (e) {
          if (e?.code === 'transition-not-found') status = 'todo';
          else throw e;
        }
      }
      // Create blocker links immediately. The CLI `add --blocked-by` validates
      // each blocker exists before calling, so the targets are present. (Sync
      // does NOT pass blockedBy here — it reconciles links in its own later pass
      // once every mirror issue exists — so this only affects direct creation.)
      for (const blockerKey of input.blockedBy ?? []) {
        await createBlocksLink(http, { sourceKey: out.key, targetKey: blockerKey });
      }
      const result = {
        id: out.key,
        type: input.type,
        parentId: input.parentId,
        title: input.title,
        description: input.description ?? '',
        status,
        blockedBy: input.blockedBy ?? [],
      };
      for (const k of META_FIELDS) if (input[k] !== undefined) result[k] = input[k];
      return result;
    },

    async updateItem(id, patch) {
      const metaInPatch = META_FIELDS.some(k => k in patch);
      const descInPatch = 'description' in patch;
      if ('title' in patch || descInPatch || metaInPatch) {
        const fpatch = {};
        if (patch.title !== undefined) fpatch.title = patch.title;
        if (metaInPatch) {
          // Read the current description so we can preserve the human prose and
          // any metadata fields this patch does not touch, then re-emit the block.
          const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=description`);
          const cur = res.status === 200 ? splitDescription(extractAdfText(res.body?.fields?.description)) : { human: '', meta: {} };
          const human = descInPatch ? patch.description : cur.human;
          const mergedMeta = { ...cur.meta };
          for (const k of META_FIELDS) if (k in patch) mergedMeta[k] = patch[k];
          fpatch.description = composeDescription(human, mergedMeta);
        } else if (descInPatch) {
          fpatch.description = patch.description;
        }
        await updateIssueFields(http, id, fpatch);
      }
      if ('status' in patch) {
        await transitionIssue(http, id, statusMap[patch.status]);
      }
      if ('blockedBy' in patch) {
        const existing = await listBlocksLinks(http, id);
        const existingByKey = new Map(existing.map(e => [e.blockerKey, e.id]));
        const target = new Set(patch.blockedBy);
        for (const e of existing) {
          if (!target.has(e.blockerKey)) await deleteLink(http, e.id);
        }
        for (const k of patch.blockedBy) {
          if (!existingByKey.has(k)) await createBlocksLink(http, { sourceKey: id, targetKey: k });
        }
      }
      // Return a minimal object reflecting the patch — sync callers re-read if they need fresh state
      return { id, ...patch };
    },

    _http: http,
    _config: { projectKey, issueTypes, statusMap },
  };
}
