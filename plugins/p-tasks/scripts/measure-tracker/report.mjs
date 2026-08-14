// Placeholder until Task 9 builds the real report. `measure-tracker.mjs`
// (Task 8) imports `report` at the top of the file, so this module has to
// exist and export that name before Task 9 lands, or the CLI — and the queue
// unit test, which imports the whole CLI module — cannot be loaded at all.
//
// Task 9 replaces this file with the full markdown tables (the study's
// numbers, arm by arm). This stub only keeps the import alive; it carries no
// logic worth testing on its own.
export function report(rows) {
  return rows.length === 0
    ? 'no runs\n'
    : `${rows.length} row(s) recorded. Full report lands in Task 9.\n`;
}
