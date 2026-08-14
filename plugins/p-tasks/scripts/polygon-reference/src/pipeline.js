// R20 — resolve with layers, named. R21 — a list is replaced whole, never
// appended (a consequence of R4's mergeLayers, no extra code needed for it).
import { parseIni } from './parse.js';
import { resolveIncludes } from './include.js';
import { envToConfig } from './env.js';
import { parseFlags } from './flags.js';
import { defaultsAsLayer } from './defaultsLayer.js';
import { mergeLayers } from './merge.js';
import { validate } from './schema.js';
import { coerceExtraTypes } from './types.js';

export function resolveLayers({ text, argv, env, envPrefix, includeFiles, schema }) {
  const fromFile = parseIni(text);
  const withIncludes = resolveIncludes(fromFile, includeFiles);
  const fromEnv = envToConfig(env, envPrefix);
  const fromFlags = parseFlags(argv).set;
  const defaultsLayer = defaultsAsLayer(schema);
  // Defaults lowest, then file (includes already folded in), then env, then flags.
  const merged = mergeLayers([defaultsLayer, withIncludes, fromEnv, fromFlags]);

  const validated = validate(merged, schema);
  if (!validated.ok) return validated;

  return coerceExtraTypes(validated.value, schema);
}
