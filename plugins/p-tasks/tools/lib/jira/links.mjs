// In Jira's "Blocks" link type:
//   outwardIssue is the source ("PROJ-A blocks PROJ-B")
//   inwardIssue is the target ("PROJ-B is blocked by PROJ-A")
// We model blockedBy on the inward side: if our item depends on PROJ-2, our item is the inward side.

export async function createBlocksLink(http, { sourceKey, targetKey }) {
  // sourceKey is blocked by targetKey
  const res = await http.post('/rest/api/3/issueLink', {
    type: { name: 'Blocks' },
    inwardIssue: { key: sourceKey },
    outwardIssue: { key: targetKey },
  });
  if (res.status !== 201 && res.status !== 200) throw Object.assign(new Error(`link failed: ${res.status}`), { status: res.status });
}

export async function deleteLink(http, linkId) {
  const res = await http.delete(`/rest/api/3/issueLink/${encodeURIComponent(linkId)}`);
  if (res.status !== 204 && res.status !== 200) throw Object.assign(new Error(`delete link failed: ${res.status}`), { status: res.status });
}

export async function listBlocksLinks(http, issueKey) {
  const res = await http.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`);
  if (res.status !== 200) throw Object.assign(new Error(`list links failed: ${res.status}`), { status: res.status });
  const links = res.body?.fields?.issuelinks ?? [];
  return links
    .filter(l => l.type?.name === 'Blocks' && l.inwardIssue?.key === issueKey && l.outwardIssue?.key)
    .map(l => ({ id: l.id, blockerKey: l.outwardIssue.key }));
}
