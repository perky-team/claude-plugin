// R35 — a dotenv-style report. R36 — a flat `path=value` report.
import { joinPath } from './paths.js';

export function toDotenv(value) {
  const lines = [];
  for (const section of Object.keys(value).sort()) {
    for (const key of Object.keys(value[section]).sort()) {
      const name = section === '' ? key.toUpperCase() : `${section.toUpperCase()}_${key.toUpperCase()}`;
      lines.push(`${name}=${String(value[section][key])}`);
    }
  }
  return lines.join('\n');
}

export function toFlat(value) {
  const lines = [];
  for (const section of Object.keys(value).sort()) {
    for (const key of Object.keys(value[section]).sort()) {
      lines.push(`${joinPath(section, key)}=${String(value[section][key])}`);
    }
  }
  return lines.join('\n');
}
