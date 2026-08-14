// R6 — resolve everything.
import { parseIni } from './parse.js';
import { parseFlags } from './flags.js';
import { mergeLayers } from './merge.js';
import { applyDefaults } from './defaults.js';
import { validate } from './schema.js';

export function resolve({ text, argv, schema }) {
  const fromFile = parseIni(text);
  const { set } = parseFlags(argv);
  const merged = mergeLayers([fromFile, set]);
  return validate(applyDefaults(merged, schema), schema);
}
