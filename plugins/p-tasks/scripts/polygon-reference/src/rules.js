// R22 — minimum and maximum. R23 — one of a fixed set of values.
// R24 — a pattern. R25 — required together. R26 — mutually exclusive.
// R27 — unknown keys (strict mode). R28 — string length.
// R29 — required if another path has a value. R30 — list item count.
// R31 — no duplicate list items. R57 — flag a deprecated path.
import { splitPath, joinPath } from './paths.js';

function pathCompare(a, b) {
  return a.path === b.path ? 0 : a.path < b.path ? -1 : 1;
}

function isPresent(rawConfig, path) {
  const [section, key] = splitPath(path);
  return rawConfig[section]?.[key] !== undefined;
}

function done(errors) {
  errors.sort(pathCompare);
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function checkRange(value, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (rule.min === undefined && rule.max === undefined) continue;
    const [section, key] = splitPath(path);
    const v = value[section]?.[key];
    if (v === undefined) continue;
    if (rule.min !== undefined && v < rule.min) {
      errors.push({ path, message: `must be at least ${rule.min}` });
      continue;
    }
    if (rule.max !== undefined && v > rule.max) {
      errors.push({ path, message: `must be at most ${rule.max}` });
    }
  }
  return done(errors);
}

export function checkOneOf(rawConfig, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (!rule.oneOf) continue;
    const [section, key] = splitPath(path);
    const v = rawConfig[section]?.[key];
    if (v === undefined) continue;
    if (!rule.oneOf.includes(v)) {
      errors.push({ path, message: `must be one of ${rule.oneOf.join(', ')}` });
    }
  }
  return done(errors);
}

export function checkPattern(rawConfig, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (rule.pattern === undefined) continue;
    const [section, key] = splitPath(path);
    const v = rawConfig[section]?.[key];
    if (v === undefined) continue;
    if (!new RegExp(rule.pattern).test(v)) {
      errors.push({ path, message: `must match ${rule.pattern}` });
    }
  }
  return done(errors);
}

export function checkRequiredTogether(rawConfig, groups) {
  const errors = [];
  for (const group of groups) {
    const anyPresent = group.some((path) => isPresent(rawConfig, path));
    if (!anyPresent) continue;
    for (const path of group) {
      if (isPresent(rawConfig, path)) continue;
      const others = group.filter((p) => p !== path);
      errors.push({ path, message: `must be set together with ${others.join(', ')}` });
    }
  }
  return done(errors);
}

export function checkMutuallyExclusive(rawConfig, groups) {
  const errors = [];
  for (const group of groups) {
    const present = group.filter((path) => isPresent(rawConfig, path));
    if (present.length < 2) continue;
    for (const path of present) {
      const others = present.filter((p) => p !== path);
      errors.push({ path, message: `cannot be set together with ${others.join(', ')}` });
    }
  }
  return done(errors);
}

export function checkUnknownKeys(rawConfig, schema) {
  const errors = [];
  for (const [section, keys] of Object.entries(rawConfig)) {
    for (const key of Object.keys(keys)) {
      const path = joinPath(section, key);
      if (!Object.hasOwn(schema, path)) errors.push({ path, message: 'unknown key' });
    }
  }
  return done(errors);
}

export function checkLength(rawConfig, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (rule.minLength === undefined && rule.maxLength === undefined) continue;
    if (rule.type !== undefined && rule.type !== 'string') continue;
    const [section, key] = splitPath(path);
    const v = rawConfig[section]?.[key];
    if (v === undefined) continue;
    if (rule.minLength !== undefined && v.length < rule.minLength) {
      errors.push({ path, message: `must be at least ${rule.minLength} characters` });
      continue;
    }
    if (rule.maxLength !== undefined && v.length > rule.maxLength) {
      errors.push({ path, message: `must be at most ${rule.maxLength} characters` });
    }
  }
  return done(errors);
}

export function checkRequiredIf(rawConfig, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (!rule.requiredIf) continue;
    const { path: otherPath, equals } = rule.requiredIf;
    const [oSection, oKey] = splitPath(otherPath);
    if (rawConfig[oSection]?.[oKey] !== equals) continue;
    if (!isPresent(rawConfig, path)) {
      errors.push({ path, message: `is required when ${otherPath} is ${equals}` });
    }
  }
  return done(errors);
}

export function checkListLength(value, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (rule.minItems === undefined && rule.maxItems === undefined) continue;
    const [section, key] = splitPath(path);
    const v = value[section]?.[key];
    if (v === undefined) continue;
    if (rule.minItems !== undefined && v.length < rule.minItems) {
      errors.push({ path, message: `must have at least ${rule.minItems} items` });
      continue;
    }
    if (rule.maxItems !== undefined && v.length > rule.maxItems) {
      errors.push({ path, message: `must have at most ${rule.maxItems} items` });
    }
  }
  return done(errors);
}

export function checkUnique(value, schema) {
  const errors = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (!rule.unique) continue;
    const [section, key] = splitPath(path);
    const v = value[section]?.[key];
    if (v === undefined) continue;
    const seen = new Set();
    for (const item of v) {
      if (seen.has(item)) {
        errors.push({ path, message: 'must not repeat a value' });
        break;
      }
      seen.add(item);
    }
  }
  return done(errors);
}

export function checkDeprecated(rawConfig, schema) {
  // A schema-authoring mistake, checked once per call, before rawConfig matters at all.
  for (const rule of Object.values(schema)) {
    if (typeof rule.deprecated === 'string' && !Object.hasOwn(schema, rule.deprecated)) {
      throw new TypeError(`unknown replacement path: ${rule.deprecated}`);
    }
  }

  const warnings = [];
  for (const [path, rule] of Object.entries(schema)) {
    if (!rule.deprecated) continue;
    if (!isPresent(rawConfig, path)) continue;
    const message = typeof rule.deprecated === 'string'
      ? `is deprecated, use ${rule.deprecated} instead`
      : 'is deprecated';
    warnings.push({ path, message });
  }
  warnings.sort(pathCompare);
  return { warnings };
}
