#!/usr/bin/env node
// pchat — dumb Telegram channel CLI. p-chat never schedules anything and never
// decides content: p-shed jobs own both. Exit codes: 0 ok, 1 internal, 2
// config/validation/API (a BROKEN channel must be visible to p-shed's breaker),
// 75 = guard says "deliberately quiet".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, findRoot, paths, readConfig, readToken, tokenPermsWarning } from './lib/config.mjs';
import { ApiError, makeApi } from './lib/api.mjs';
import { guardScan, initDiscover, listPending } from './lib/core.mjs';
import { ackUntil, appendLocalLog, ensureGitignore, readOffset, resetSession, sessionStatus, writeOffset } from './lib/state.mjs';
import { sendText } from './lib/send.mjs';

// Version comes from the plugin manifest, never a constant here: a release bumps
// plugin.json#version only, so a hardcoded copy drifts silently. The manifest ships in
// the same copied tree, so this resolves in the installed plugin cache too; a missing
// manifest degrades to 0.0.0 rather than killing an unrelated command.
export function readVersion() {
  try {
    const manifest = new URL('../.claude-plugin/plugin.json', import.meta.url);
    return JSON.parse(readFileSync(manifest, 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const GUARD_QUIET = 75; // p-shed's quiet exit — EX_TEMPFAIL, deliberate by contract

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[key] = true;
        } else {
          out[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Set process.exitCode and return — never call process.exit() here. On Windows a hard
// exit while undici still holds a keep-alive socket from an earlier request kills the
// process with a libuv assert (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c)
// and exit code 0xC0000409 / 3221226505. Every command that touches the Bot API twice
// hits it — `guard` alone does getUpdates + sendMessage — and p-shed would read that
// crash code as a broken job instead of the guard's 0 / 75 contract. Returning lets the
// event loop drain the sockets first; the exit code survives.
// Callers MUST `return emitJson(...)` / `return die(...)` — these no longer stop
// execution on their own.
export function emitJson(obj, exitCode = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = exitCode;
}

export function die(message, exitCode = 1) {
  process.stderr.write(message + '\n');
  process.exitCode = exitCode;
}

const KNOWN = ['init', 'guard', 'pending', 'ack', 'send', 'reset', 'status'];

async function main() {
  if (process.argv[2] === '--version') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (!KNOWN.includes(command)) return die(`unknown command: ${command}`, 1);
  const root = findRoot(process.cwd());

  try {
    if (command === 'init') {
      const tokenFile = args['token-file'];
      if (typeof tokenFile !== 'string' || !tokenFile) throw new ConfigError('init requires --token-file <path>');
      if (existsSync(paths(root).config)) throw new ConfigError('.pchat.json already exists — edit it directly, or delete it to re-init');
      const token = readToken({ tokenFile }, root);
      const apiBase = typeof args['api-base'] === 'string' ? args['api-base'] : 'https://api.telegram.org';
      const api = makeApi({ apiBase, token });
      const chatId = args['chat-id'] !== undefined ? Number(args['chat-id']) : undefined;
      const { me, chatId: discovered, confirmed } = await initDiscover({ api, chatId });
      const cfg = {
        tokenFile,
        allowedChatIds: [discovered],
        defaultChatId: discovered,
        commands: {},
        sessionFile: '.pchat/session.md',
        ...(apiBase !== 'https://api.telegram.org' ? { apiBase } : {}),
      };
      writeFileSync(paths(root).config, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      writeOffset(root, { confirmed, lastPollAt: Date.now() });
      ensureGitignore(root);
      const warning = tokenPermsWarning(cfg, root);
      return emitJson({ action: 'init', bot: me.username, chatId: discovered, confirmed, ...(warning ? { warning } : {}) }, 0);
    }

    const cfg = readConfig(root);

    // Purely local commands — no token, no network.
    if (command === 'reset') {
      return emitJson({ action: 'reset', file: resetSession(root, cfg) }, 0);
    }
    if (command === 'status') {
      const offset = readOffset(root);
      return emitJson({
        action: 'status',
        confirmed: offset.confirmed,
        lastPollAt: offset.lastPollAt,
        session: sessionStatus(root, cfg),
        allowedChatIds: cfg.allowedChatIds ?? [],
        commands: Object.keys(cfg.commands ?? {}),
      }, 0);
    }
    if (command === 'ack') {
      if (args.until === undefined) throw new ConfigError('ack requires --until <update_id>');
      const next = ackUntil(root, Number(args.until));
      return emitJson({ action: 'ack', confirmed: next.confirmed }, 0);
    }

    const token = readToken(cfg, root);
    const api = makeApi({ apiBase: cfg.apiBase, token, timeoutSec: cfg.apiTimeoutSec });

    if (command === 'guard') {
      const r = await guardScan({ root, cfg, api });
      return emitJson({ action: 'guard', ...r }, r.result === 'quiet' ? GUARD_QUIET : 0);
    }
    if (command === 'pending') {
      return emitJson({ action: 'pending', pending: await listPending({ root, cfg, api }) }, 0);
    }
    if (command === 'send') {
      if (args._.length === 0) throw new ConfigError('send requires <text> or - (stdin)');
      const text = args._[0] === '-' ? readFileSync(0, 'utf-8') : args._.join(' ');
      const to = args.to !== undefined ? Number(args.to) : undefined;
      const r = await sendText({ api, cfg, chatId: to, text, log: (rec) => appendLocalLog(root, { ts: Date.now(), ...rec }) });
      return emitJson({ action: 'send', ...r }, 0);
    }
  } catch (e) {
    if (e instanceof ConfigError) return emitJson({ error: { code: 'config', message: e.message } }, 2);
    if (e instanceof ApiError) return emitJson({ error: { code: 'api', message: e.message } }, 2);
    return emitJson({ error: { code: 'internal', message: e?.message ?? String(e) } }, 1);
  }
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) main();
