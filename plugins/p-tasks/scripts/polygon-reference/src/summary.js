// R41 — summarize an error list. R42 — print a summary.
export function summarizeErrors(errors) {
  const paths = [...new Set(errors.map((e) => e.path))].sort();
  return { count: errors.length, paths };
}

export function formatSummary({ count, paths }) {
  if (count === 0) return 'no errors';
  return `${count} error(s) across ${paths.length} path(s): ${paths.join(', ')}`;
}
