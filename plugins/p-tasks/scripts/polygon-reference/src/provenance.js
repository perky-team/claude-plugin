// R33 — trace which layer set each key. R34 — print the trace.
// R53 — explain one path in one sentence. R54 — the full layer history of
// every path. R55 — print a layer history.
import { joinPath } from './paths.js';

export function traceLayers(layers, names) {
  const out = {};
  for (let i = 0; i < layers.length; i++) {
    for (const [section, keys] of Object.entries(layers[i])) {
      for (const [key, value] of Object.entries(keys)) {
        // Reassigning an existing key only updates its value — insertion
        // order (and so the path's position in `out`) never moves.
        out[joinPath(section, key)] = { value, layer: names[i] };
      }
    }
  }
  return out;
}

export function formatProvenance(trace) {
  return Object.keys(trace)
    .sort()
    .map((path) => `${path} = ${trace[path].value} (${trace[path].layer})`)
    .join('\n');
}

export function explainWinner(trace, path) {
  if (!Object.hasOwn(trace, path)) return `${path} was never set`;
  return `${path} = ${trace[path].value} (set by ${trace[path].layer})`;
}

export function tracedHistory(layers, names) {
  const out = {};
  for (let i = 0; i < layers.length; i++) {
    for (const [section, keys] of Object.entries(layers[i])) {
      for (const [key, value] of Object.entries(keys)) {
        const path = joinPath(section, key);
        out[path] ??= [];
        out[path].push({ layer: names[i], value });
      }
    }
  }
  return out;
}

export function formatHistory(history) {
  return Object.keys(history)
    .sort()
    .map((path) => `${path}: ${history[path].map((h) => `${h.layer}=${h.value}`).join(' -> ')}`)
    .join('\n');
}
