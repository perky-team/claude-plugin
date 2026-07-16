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
