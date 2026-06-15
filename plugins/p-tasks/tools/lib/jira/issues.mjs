function adfPlain(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: text || '' }] }] };
}

export async function createIssue(http, { projectKey, issueType, summary, description, parentKey }) {
  const fields = {
    project: { key: projectKey },
    issuetype: { name: issueType },
    summary,
  };
  if (description !== undefined) fields.description = adfPlain(description);
  if (parentKey) fields.parent = { key: parentKey };
  const res = await http.post('/rest/api/3/issue', { fields });
  if (res.status !== 201 && res.status !== 200) throw Object.assign(new Error(`create failed: ${res.status}`), { status: res.status });
  return { id: res.body.id, key: res.body.key };
}

export async function updateIssueFields(http, key, patch) {
  const fields = {};
  if ('title' in patch) fields.summary = patch.title;
  if ('description' in patch) fields.description = adfPlain(patch.description);
  if (Object.keys(fields).length === 0) return;
  const res = await http.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
  if (res.status !== 204 && res.status !== 200) throw Object.assign(new Error(`update failed: ${res.status}`), { status: res.status });
}

export async function transitionIssue(http, key, targetStatusName) {
  const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  if (res.status !== 200) throw Object.assign(new Error(`transitions failed: ${res.status}`), { status: res.status });
  const t = (res.body?.transitions ?? []).find(x => x.to?.name === targetStatusName);
  if (!t) throw Object.assign(new Error(`no transition to ${targetStatusName}`), { code: 'transition-not-found' });
  const apply = await http.post(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
  if (apply.status !== 204) throw Object.assign(new Error(`transition apply failed: ${apply.status}`), { status: apply.status });
}

export async function listIssues(http, jql) {
  // Jira Cloud removed the legacy /rest/api/3/search (startAt/total paging) in
  // 2025. The replacement /rest/api/3/search/jql uses opaque token paging and
  // returns no total — iterate until isLast (or no nextPageToken).
  const out = [];
  let nextPageToken;
  while (true) {
    const body = { jql, maxResults: 100, fields: ['summary', 'description', 'status', 'issuetype', 'parent', 'issuelinks'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await http.post('/rest/api/3/search/jql', body);
    if (res.status !== 200) throw Object.assign(new Error(`search failed: ${res.status}`), { status: res.status });
    out.push(...(res.body.issues ?? []));
    nextPageToken = res.body.nextPageToken;
    if (res.body.isLast === true || !nextPageToken) break;
  }
  return out;
}
