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

export function createJiraDestination({ block, email, token, transport, name = 'jira' }) {
  const http = createHttpClient({ baseUrl: block.siteUrl, email, token, transport });
  const { projectKey, issueTypes, statusMap, jql } = block;

  function toItem(issue) {
    const it = issue.fields.issuetype?.name;
    const type = it === issueTypes.task ? 'task' : 'sub-task';
    const base = {
      id: issue.key,
      type,
      title: issue.fields.summary ?? '',
      description: extractAdfText(issue.fields.description),
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
        description: input.description ?? '',
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
      return {
        id: out.key,
        type: input.type,
        parentId: input.parentId,
        title: input.title,
        description: input.description ?? '',
        status,
        blockedBy: input.blockedBy ?? [],
      };
    },

    async updateItem(id, patch) {
      if ('title' in patch || 'description' in patch) {
        const fpatch = {};
        if (patch.title !== undefined) fpatch.title = patch.title;
        if (patch.description !== undefined) fpatch.description = patch.description;
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
