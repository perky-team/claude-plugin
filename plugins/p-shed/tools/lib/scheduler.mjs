import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function taskName(root) {
  const hash = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 8);
  return `pshed-${hash}`;
}

// Windows: wrap in cmd so we can cd into the folder before running tick.
export function buildInstall({ platform, root, nodeBin, toolPath }) {
  if (platform !== 'win32') throw new Error('buildInstall is win32-only; POSIX uses crontab transforms');
  const tr = `cmd /c cd /d "${resolve(root)}" && "${nodeBin}" "${toolPath}" tick`;
  return { file: 'schtasks', args: ['/Create', '/TN', taskName(root), '/SC', 'MINUTE', '/TR', tr, '/F'] };
}

export function buildRemove({ platform, root }) {
  if (platform !== 'win32') throw new Error('buildRemove is win32-only; POSIX uses crontab transforms');
  return { file: 'schtasks', args: ['/Delete', '/TN', taskName(root), '/F'] };
}

// POSIX crontab: minimal env is handled by absolute paths; cd sets the working dir.
export function crontabLine({ root, nodeBin, toolPath }) {
  return `* * * * * cd "${root}" && "${nodeBin}" "${toolPath}" tick > "${root}/.pshed/logs/cron.log" 2>&1 # ${taskName(root)}`;
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
