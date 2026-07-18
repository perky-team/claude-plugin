import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayJournal } from '../lib/journal.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'pobserve.mjs');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function spawnCli(args: string[], cwd: string) {
  const child = spawn('node', [CLI, ...args], { cwd }) as ChildProcessWithoutNullStreams;
  let acc = '';
  child.stdout.on('data', (chunk) => { acc += chunk.toString('utf-8'); });
  child.stderr.on('data', () => { /* swallow */ });
  child.on('error', () => { /* swallow spawn errors so tests can assert via waitFor */ });
  return { child, out: () => acc };
}

async function waitFor(pred: () => boolean, timeoutMs = 15000, stepMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return pred();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let root: string;
let children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pobs-e2e-live-'));
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      try { child.kill(); } catch { /* SIGKILL fallback, already gone */ }
    }
  }
  await sleep(200);
  rmSync(root, { recursive: true, force: true });
});

describe('pobserve watch / capture (live e2e)', () => {
  it('streams a backfilled p-shed completion', async () => {
    const logsDir = join(root, '.pshed', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, `${todayStr()}.jsonl`),
      JSON.stringify({ ts: Date.now(), job: 'daily-index', exit: 0, durationMs: 42000 }) + '\n',
    );

    const { child, out } = spawnCli(['watch'], root);
    children.push(child);

    const found = await waitFor(() => /daily-index/.test(out()) && /exit 0/.test(out()));

    child.kill('SIGTERM');
    expect(found).toBe(true);
  }, 30000);

  it('streams a live p-shed completion appended after start', async () => {
    const logsDir = join(root, '.pshed', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, `${todayStr()}.jsonl`), '');

    const { child, out } = spawnCli(['watch'], root);
    children.push(child);

    await sleep(1500); // let the pshed adapter's fs.watch attach

    appendFileSync(
      join(logsDir, `${todayStr()}.jsonl`),
      JSON.stringify({ ts: Date.now(), job: 'live-job', exit: 1, durationMs: 3000 }) + '\n',
    );

    const found = await waitFor(() => /live-job/.test(out()));

    child.kill('SIGTERM');
    expect(found).toBe(true);
  }, 30000);

  it('persists to the journal and does not re-amplify on restart', async () => {
    const logsDir = join(root, '.pshed', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, `${todayStr()}.jsonl`), '');
    const journalDir = join(root, '.pobserve');

    // Session 1
    const session1 = spawnCli(['capture'], root);
    children.push(session1.child);

    await sleep(1500);
    appendFileSync(
      join(logsDir, `${todayStr()}.jsonl`),
      JSON.stringify({ ts: Date.now(), job: 'j1', exit: 0 }) + '\n',
    );

    const foundJ1 = await waitFor(() => replayJournal(journalDir).some((e: any) => e.entity === 'j1'));
    expect(foundJ1).toBe(true);

    session1.child.kill('SIGTERM');
    await sleep(600);

    // Session 2 (restart) — the journal from session 1 is already present.
    const session2 = spawnCli(['capture'], root);
    children.push(session2.child);

    await sleep(1500);
    appendFileSync(
      join(logsDir, `${todayStr()}.jsonl`),
      JSON.stringify({ ts: Date.now(), job: 'j2', exit: 0 }) + '\n',
    );

    const foundJ2 = await waitFor(() => replayJournal(journalDir).some((e: any) => e.entity === 'j2'));
    expect(foundJ2).toBe(true);

    session2.child.kill('SIGTERM');
    await sleep(600);

    const evs = replayJournal(journalDir);
    expect(evs.filter((e: any) => e.entity === 'j1')).toHaveLength(1);
    expect(evs.filter((e: any) => e.entity === 'j2')).toHaveLength(1);
  }, 30000);
});
