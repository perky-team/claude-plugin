import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const run = (label, path) => {
  process.stdout.write(`\n→ ${label}\n`);
  const r = spawnSync('claude', ['plugin', 'validate', path], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(r.error.message);
    failures.push(label);
    return;
  }
  if (r.status !== 0) failures.push(label);
};

run('marketplace', '.');

const pluginsDir = join(repoRoot, 'plugins');
if (existsSync(pluginsDir)) {
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsDir, entry.name);
    if (!existsSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) continue;
    run(`plugin: ${entry.name}`, pluginDir);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} validation(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log('\nAll manifests validated.');
