// Returns null on acyclic graph; otherwise returns the cycle as an array of ids.
export function findCycle(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const i of items) color.set(i.id, WHITE);

  function dfs(start) {
    const stack = [{ id: start, ptr: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = byId.get(top.id);
      const neighbors = node?.blockedBy ?? [];
      if (top.ptr < neighbors.length) {
        const next = neighbors[top.ptr++];
        if (!byId.has(next)) continue;
        const c = color.get(next);
        if (c === GRAY) {
          const cycle = [next];
          for (let i = stack.length - 1; i >= 0; i--) {
            cycle.push(stack[i].id);
            if (stack[i].id === next) break;
          }
          return cycle.reverse();
        }
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ id: next, ptr: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
    return null;
  }

  for (const i of items) {
    if (color.get(i.id) === WHITE) {
      const c = dfs(i.id);
      if (c) return c;
    }
  }
  return null;
}
