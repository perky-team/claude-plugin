import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockApi, msg, type MockApi } from './mock-api';

const CLI = join(process.cwd(), 'plugins/p-chat/tools/pchat.mjs');
const TOKEN = 'TESTTOKEN123';

let root: string;
let mock: MockApi;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pchat-e2e-'));
  mkdirSync(join(root, '.git')); // findRoot anchor
  mock = await startMockApi(TOKEN);
  writeFileSync(join(root, 'token.txt'), TOKEN + '\n', 'utf-8');
});
afterEach(async () => { await mock.close(); rmSync(root, { recursive: true, force: true }); });

// The /status command tool: a tiny node one-liner, cross-platform.
const STATUS_CMD = 'node -e "console.log(\'loop: all green\')"';

const writeCfg = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(root, '.pchat.json'), JSON.stringify({
    tokenFile: 'token.txt',
    allowedChatIds: [111],
    defaultChatId: 111,
    commands: { '/status': STATUS_CMD },
    sessionFile: '.pchat/session.md',
    apiBase: mock.url,
    ...extra,
  }), 'utf-8');

// ASYNC on purpose: the mock Bot API lives in THIS process, so a synchronous
// execFileSync would block the event loop and the server could never answer the
// child — every network command would hang until its abort timeout.
const run = (args: string[], input?: string) =>
  new Promise<{ status: number; stdout: string }>((resolveP) => {
    const child = execFile('node', [CLI, ...args], { encoding: 'utf-8', cwd: root }, (err: any, stdout) => {
      resolveP({ status: err ? ((err.code as number) ?? 1) : 0, stdout: (stdout ?? '') as string });
    });
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
const confirmed = () => JSON.parse(readFileSync(join(root, '.pchat', 'offset.json'), 'utf-8')).confirmed;

describe('pchat cli e2e (mock Bot API)', () => {
  it('guard: empty queue -> 75; free text -> 0; ack -> 75 again (the full at-least-once loop)', async () => {
    writeCfg();
    expect((await run(['guard'])).status).toBe(75);

    const q = msg(111, 'how is the loop?');
    mock.seed(q);
    expect((await run(['guard'])).status).toBe(0);

    // pending re-serves the SAME question until acked (kill-between-send-and-ack safety)
    const p1 = JSON.parse((await run(['pending'])).stdout).pending;
    expect(p1).toHaveLength(1);
    expect(p1[0]).toMatchObject({ updateId: q.update_id, text: 'how is the loop?' });
    const p2 = JSON.parse((await run(['pending'])).stdout).pending;
    expect(p2).toHaveLength(1); // re-served — not consumed by reading

    expect((await run(['ack', '--until', String(q.update_id)])).status).toBe(0);
    expect((await run(['guard'])).status).toBe(75);
    expect(JSON.parse((await run(['pending'])).stdout).pending).toHaveLength(0);
  }, 20000);

  it('guard answers a scripted /command without any Claude involvement and confirms it', async () => {
    writeCfg();
    const c = msg(111, '/status');
    mock.seed(c);
    expect((await run(['guard'])).status).toBe(75); // command served, nothing left -> quiet
    expect(mock.state.sent).toHaveLength(1);
    expect(mock.state.sent[0].text).toContain('loop: all green');
    expect(confirmed()).toBe(c.update_id);
  }, 20000);

  it('ordering e2e: [q1, /status, q2] — answer q1, ack, THEN the command runs, then q2', async () => {
    writeCfg();
    const q1 = msg(111, 'first question');
    const c = msg(111, '/status');
    const q2 = msg(111, 'second question');
    mock.seed(q1); mock.seed(c); mock.seed(q2);

    expect((await run(['guard'])).status).toBe(0);
    expect(mock.state.sent).toHaveLength(0);          // command NOT executed yet (behind q1)
    const p = JSON.parse((await run(['pending'])).stdout).pending;
    expect(p.map((x: { text: string }) => x.text)).toEqual(['first question']); // stops before /status

    await run(['ack', '--until', String(q1.update_id)]);
    expect((await run(['guard'])).status).toBe(0);    // command answered, q2 now pending
    expect(mock.state.sent).toHaveLength(1);
    expect(confirmed()).toBe(c.update_id);            // cursor never jumped q2
    expect(JSON.parse((await run(['pending'])).stdout).pending.map((x: { text: string }) => x.text)).toEqual(['second question']);
  }, 20000);

  it('non-allowlisted chats and stickers are skipped + logged, never answered', async () => {
    writeCfg();
    mock.seed(msg(999, '/status'));
    mock.seed(msg(999, 'hello?'));
    mock.seed(msg(111, undefined, { sticker: {} }));
    expect((await run(['guard'])).status).toBe(75);
    expect(mock.state.sent).toHaveLength(0);
    const log = readFileSync(join(root, '.pchat', 'log.jsonl'), 'utf-8');
    expect(log.match(/skipped-update/g)!.length).toBe(3);
  }, 20000);

  it('free text NEVER reaches the commands shell: "/status; echo pwned" is a question, not a command', async () => {
    writeCfg();
    mock.seed(msg(111, '/status; echo pwned'));
    expect((await run(['guard'])).status).toBe(0); // free text -> work
    expect(mock.state.sent).toHaveLength(0);
  }, 20000);

  it('negative self-tests: guard exits 2 (not 75) on empty allowlist and unreachable API', async () => {
    writeCfg({ allowedChatIds: [] });
    expect((await run(['guard'])).status).toBe(2);
    writeCfg({ apiBase: 'http://127.0.0.1:1' }); // nothing listens there
    expect((await run(['guard'])).status).toBe(2);
  }, 20000);

  it('ack refuses to move backwards', async () => {
    writeCfg();
    const q = msg(111, 'q');
    mock.seed(q);
    await run(['guard']);
    await run(['ack', '--until', String(q.update_id)]);
    expect((await run(['ack', '--until', String(q.update_id - 5)])).status).toBe(2);
  }, 20000);

  it('send: argv text, stdin via "-", 4096 split, markdown fallback, allowlist refusal', async () => {
    writeCfg();
    expect((await run(['send', 'hello *world*'])).status).toBe(0);
    expect(mock.state.sent.at(-1)).toMatchObject({ chat_id: 111, text: 'hello *world*', parse_mode: 'Markdown' });

    expect((await run(['send', '-'], 'x'.repeat(5000))).status).toBe(0);
    expect(mock.state.sent).toHaveLength(3); // 1 + 2 chunks

    mock.state.rejectParseMode = true;
    expect((await run(['send', 'broken _markdown'])).status).toBe(0);
    expect(mock.state.sent.at(-1).parse_mode).toBeUndefined();
    mock.state.rejectParseMode = false;

    expect((await run(['send', '--to', '999', 'leak'])).status).toBe(2);
  }, 20000);

  it('init discovers the chat id, baselines the cursor, writes config + gitignore; refuses a re-init', async () => {
    const seed = msg(777, 'hi bot');
    mock.seed(seed);
    const r = await run(['init', '--token-file', 'token.txt', '--api-base', mock.url]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ action: 'init', bot: 'mock_bot', chatId: 777 });
    const cfg = JSON.parse(readFileSync(join(root, '.pchat.json'), 'utf-8'));
    expect(cfg.allowedChatIds).toEqual([777]);
    expect(cfg.defaultChatId).toBe(777);
    expect(confirmed()).toBe(seed.update_id); // stale history never replayed
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('.pchat/');
    expect((await run(['init', '--token-file', 'token.txt', '--api-base', mock.url])).status).toBe(2);
  }, 20000);

  it('init without --chat-id and without pending updates exits 2 with guidance', async () => {
    const r = await run(['init', '--token-file', 'token.txt', '--api-base', mock.url]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.message).toMatch(/message first/);
  }, 20000);

  it('reset truncates the session; status reports offsets and session size', async () => {
    writeCfg();
    mkdirSync(join(root, '.pchat'), { recursive: true });
    writeFileSync(join(root, '.pchat', 'session.md'), '## Q/A\n', 'utf-8');
    let st = JSON.parse((await run(['status'])).stdout);
    expect(st.session.bytes).toBeGreaterThan(0);
    expect((await run(['reset'])).status).toBe(0);
    st = JSON.parse((await run(['status'])).stdout);
    expect(st.session.bytes).toBe(0);
    expect(st).toHaveProperty('confirmed');
    expect(st).toHaveProperty('lastPollAt');
  }, 20000);
});
