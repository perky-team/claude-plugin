export function createBus({ size = 500 } = {}) {
  const buf = [];
  const subs = new Set();
  return {
    push(event) {
      buf.push(event);
      if (buf.length > size) buf.shift();
      for (const fn of subs) fn(event);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    snapshot() { return buf.slice(); },
  };
}
