// R4 — merge layers.
export function mergeLayers(layers) {
  const out = {};
  for (const layer of layers) {
    for (const [section, keys] of Object.entries(layer)) {
      // Spread makes a fresh object every time, so no input is touched.
      out[section] = { ...out[section], ...keys };
    }
  }
  return out;
}
