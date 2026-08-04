import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function taskName(root) {
  const hash = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8);
  return `pshed-${hash}`;
}

// Windows: wrap in cmd so we can cd into the folder before running tick.
//
// This branch deliberately keeps the literal (versioned) toolPath, unlike crontabLine
// below. Stated rather than left silent, because the same disposable-cache-directory
// argument does apply here:
//   1. The incident is Linux-only — the loop runs on a Pi; on Windows p-shed is used
//      interactively, where a broken path is noticed immediately rather than at 03:00.
//   2. Batch has no version-aware sort. `dir /b /o-n` orders lexicographically, which
//      puts 0.9.0 above 0.10.0 — a resolver that confidently picks the OLDER install is
//      worse than a pinned path that fails loudly.
//   3. Routing the resolution through `node -e` inside `schtasks /TR` inside `cmd /c`
//      means three layers of quoting plus schtasks' own `%` handling, for a risk that has
//      never been observed on this platform.
// If Windows ever needs it, the fix is a resolver FILE (not an inline command) that
// schtasks points at — not a longer /TR string.
export function buildInstall({ platform, root, nodeBin, toolPath }) {
  if (platform !== 'win32') throw new Error('buildInstall is win32-only; POSIX uses crontab transforms');
  const tr = `cmd /c cd /d "${resolve(root)}" && "${nodeBin}" "${toolPath}" tick`;
  return { file: 'schtasks', args: ['/Create', '/TN', taskName(root), '/SC', 'MINUTE', '/TR', tr, '/F'] };
}

export function buildRemove({ platform, root }) {
  if (platform !== 'win32') throw new Error('buildRemove is win32-only; POSIX uses crontab transforms');
  return { file: 'schtasks', args: ['/Delete', '/TN', taskName(root), '/F'] };
}

// A plugin is installed into a VERSIONED cache directory (.../p-shed/0.10.0/tools/…),
// and the plugin system treats those directories as disposable — measured on the live
// Pi: the very directory the crontab invoked every minute carried an `.orphaned_at`
// marker while the registry claimed a different version was installed. Writing that path
// into a crontab buys nothing and depends on something no one promised to keep.
//
// So: turn the version segment into a glob, and let the line resolve the newest install
// at call time. Only the segment directly above `tools/` counts, so a dev checkout
// (`plugins/p-shed/tools/pshed.mjs`) has no version to replace and keeps the old literal
// line, byte for byte. Returns null when there is nothing to generalise.
export function versionGlob(toolPath) {
  const parts = String(toolPath).split('/');
  const i = parts.findIndex((p, idx) => /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(p) && parts[idx + 1] === 'tools');
  if (i === -1) return null;
  return [...parts.slice(0, i), '*', ...parts.slice(i + 1)].join('/');
}

// POSIX crontab: minimal env is handled by absolute paths; cd sets the working dir.
//
// When the tool lives in a versioned cache, the line resolves it at call time:
//   P=$(ls -d <glob> 2>/dev/null | sort -V | tail -n 1); "<node>" "${P:-<literal>}" tick
// `sort -V` is load-bearing — as plain strings 0.9.0 sorts AFTER 0.10.0, so a bare glob
// would confidently pick the older install. The `${P:-…}` fallback keeps today's exact
// behaviour when the glob matches nothing (or coreutils are missing), so the change can
// only ever add a way for the line to work, never take one away. `ls`/`sort`/`tail` are
// named rather than absolute because their location differs across distributions, and
// they sit in cron's own default PATH (/usr/bin:/bin) — the fallback covers the rest.
// No `%` anywhere: crontab turns a bare percent sign into a newline.
export function crontabLine({ root, nodeBin, toolPath }) {
  const glob = versionGlob(toolPath);
  const resolver = glob ? `P=$(ls -d ${glob} 2>/dev/null | sort -V | tail -n 1); ` : '';
  const target = glob ? `"\${P:-${toolPath}}"` : `"${toolPath}"`;
  return `* * * * * cd "${root}" && ${resolver}"${nodeBin}" ${target} tick > "${root}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`;
}

export function applyCrontab(existing, line, marker) {
  const kept = (existing ? existing.split('\n') : []).filter((l) => l.trim() && !l.includes(marker));
  kept.push(line);
  return kept.join('\n') + '\n';
}

export function removeFromCrontab(existing, marker) {
  return (existing ? existing.split('\n') : []).filter((l) => l.trim() && !l.includes(marker)).join('\n');
}

// Every distinct pshed task id a crontab/schtasks blob tags, regardless of folder. Lets
// a remove/stop run from the wrong dir report which loops are actually installed so a
// cwd mismatch (the `remove-cron silently did nothing` incident) is obvious.
export function scanCrontabTaskIds(existing) {
  const ids = [];
  const re = /pshed-[0-9a-f]{8}/g;
  let m;
  while ((m = re.exec(existing || '')) !== null) if (!ids.includes(m[0])) ids.push(m[0]);
  return ids;
}

export function crontabHasTask(existing, root) {
  return scanCrontabTaskIds(existing).includes(taskName(root));
}

// Pure plan for remove-cron: the crontab after stripping this folder's tick line, plus
// whether a line was actually removed (diff old vs new line counts) and which pshed ids
// the crontab tagged. Callers only write when `removed` is true.
export function planRemoveCron(existing, root) {
  const marker = `# ${taskName(root)}`;
  const before = (existing ? existing.split('\n') : []).filter((l) => l.trim()).length;
  const next = removeFromCrontab(existing, marker);
  const after = (next ? next.split('\n') : []).filter((l) => l.trim()).length;
  return { next, removed: after < before, foundTaskIds: scanCrontabTaskIds(existing) };
}
