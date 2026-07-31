# p-chat — contributor guide

Deliberately dumb channel plugin. Key decisions (see
`docs/superpowers/specs/2026-07-29-pshed-guard-and-p-chat-design.md` in the repo root
for the full design + review resolutions):

- **Guard exit contract: 0 = question pending, 75 = quiet, 2 = broken.** 75 is
  EX_TEMPFAIL — deliberate by construction so a crash can never read as quiet. A
  network/API/config failure MUST be exit 2 (fail-closed, visible to p-shed's
  breaker), never 75.
- **Single cursor, strict queue order, stop at first free text.** Telegram's
  `getUpdates` confirms everything below the offset, so the cursor never jumps an
  unanswered question; a /command behind a question waits for the responder's ack.
  `pending` returns only the contiguous free-text PREFIX (stops before the first
  command) — otherwise a batch-ack would confirm an unexecuted command.
- **At-least-once, both for commands and questions**: answer first, confirm after.
  Crash between send and ack → duplicate answer. Duplicate beats silence.
- **Injection boundary in `queue.mjs`**: message text either exactly equals a
  `commands` key (after trim, own-property check) or it is free text. Never
  prefix-match, never interpolate text into a shell line.
- **Fail-closed allowlist** (`requireAllowlist`): empty = ConfigError = exit 2.
  `send` refuses targets outside the allowlist (anti-exfiltration).
- **Token discipline**: token only in `tokenFile`; it rides in the Bot API URL but
  is never logged (log records carry no URLs).
- **`apiBase` is the test seam** — the e2e suite runs the real CLI against an
  in-test mock Bot API (`__tests__/mock-api.ts`) that faithfully implements
  peek/confirm. No real network in tests. The e2e harness spawns the CLI
  ASYNCHRONOUSLY (`execFile`, not `execFileSync`): the mock server lives in the
  test process, and a sync spawn would block the event loop it answers from.
- **Never `process.exit()` in the CLI — set `process.exitCode` and return.** On Windows
  a hard exit while undici still holds a keep-alive socket from an earlier Bot API call
  aborts the process with a libuv assert (`!(handle->flags & UV_HANDLE_CLOSING)`,
  `src\win\async.c`) and exit code 3221226505. Two API calls in one run are enough, so
  `guard` (getUpdates + sendMessage), `send`, and `init` all hit it — and p-shed reads
  that crash code as a broken job instead of the 0 / 75 guard contract. `emitJson` and
  `die` therefore only set the code; every call site must `return` them.
  `__tests__/no-hard-exit.test.ts` pins this.
- **Markdown fallback**: sendMessage retries a chunk without `parse_mode` on a 400
  parse error — delivery beats formatting.
- Zero deps; Node ≥ 18 global `fetch`.
