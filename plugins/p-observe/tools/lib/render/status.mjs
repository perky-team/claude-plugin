export function formatStatus(snapshot) {
  const lines = [];
  if (snapshot.pshed) {
    const s = snapshot.pshed;
    const failed = Object.values(s.jobs ?? {}).filter((j) => j.lastExit && j.lastExit !== 0).length;
    lines.push(`p-shed   ${Object.keys(s.jobs ?? {}).length} jobs · ${s.running.length} running · ${failed} failed`);
  }
  if (snapshot.ptasks) {
    const c = snapshot.ptasks.counts ?? {};
    lines.push(`p-tasks  ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no tasks'}`);
  }
  if (snapshot.pgraph) {
    const g = snapshot.pgraph;
    lines.push(`p-graph  ${g.nodes ?? '?'} nodes · drift ${g.drift ?? '?'}`);
  }
  if (snapshot.wiki) {
    const w = snapshot.wiki;
    lines.push(`p-wiki   ${w.pages ?? 0} pages · ${w.raw ?? 0} raw · ${w.conflicts ?? 0} conflicts`);
  }
  return lines.join('\n');
}
