import { createServer } from 'node:http';

export interface MockApi {
  url: string;
  state: {
    updates: any[];
    sent: any[];
    rejectParseMode: boolean; // 400 "can't parse entities" for any parse_mode send
  };
  seed(update: any): void;
  close(): Promise<void>;
}

let nextId = 1;
export const msg = (chatId: number, text?: string, extra: Record<string, unknown> = {}) =>
  ({ update_id: nextId++, message: { message_id: nextId, date: 1_750_000_000, chat: { id: chatId }, ...(text !== undefined ? { text } : {}), ...extra } });

// Faithful-enough Bot API: getUpdates(offset) CONFIRMS (drops) updates below the
// offset and re-serves the rest — the peek/confirm semantics the guard exploits.
export function startMockApi(token: string): Promise<MockApi> {
  const state = { updates: [] as any[], sent: [] as any[], rejectParseMode: false };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (obj: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const m = new RegExp(`^/bot${token}/(\\w+)$`).exec(req.url ?? '');
      if (!m) return send({ ok: false, description: 'Unauthorized' }, 401);
      const payload = body ? JSON.parse(body) : {};
      if (m[1] === 'getMe') return send({ ok: true, result: { id: 42, is_bot: true, username: 'mock_bot' } });
      if (m[1] === 'getUpdates') {
        if (payload.offset != null) state.updates = state.updates.filter((u) => u.update_id >= payload.offset);
        return send({ ok: true, result: state.updates });
      }
      if (m[1] === 'sendMessage') {
        if (state.rejectParseMode && payload.parse_mode) {
          return send({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unbalanced" }, 400);
        }
        state.sent.push(payload);
        return send({ ok: true, result: { message_id: state.sent.length } });
      }
      return send({ ok: false, description: 'unknown method' }, 404);
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolveP({
        url: `http://127.0.0.1:${port}`,
        state,
        seed: (u) => state.updates.push(u),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
