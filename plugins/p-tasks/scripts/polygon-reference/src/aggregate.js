// R32 — aggregate every check into one result.
import { validate } from './schema.js';
import { coerceExtraTypes } from './types.js';
import {
  checkRange,
  checkLength,
  checkListLength,
  checkUnique,
  checkOneOf,
  checkPattern,
  checkRequiredTogether,
  checkMutuallyExclusive,
  checkRequiredIf,
} from './rules.js';

export function collectErrors({ rawConfig, schema, requiredTogetherGroups, mutuallyExclusiveGroups }) {
  const validated = validate(rawConfig, schema);
  if (!validated.ok) return { ok: false, stage: 'basic', errors: validated.errors };

  const typed = coerceExtraTypes(validated.value, schema);
  if (!typed.ok) return { ok: false, stage: 'basic', errors: typed.errors };

  // All nine run regardless of whether an earlier one failed — that is the
  // aggregation R27's checkUnknownKeys deliberately stays out of.
  const results = [
    checkRange(typed.value, schema),
    checkLength(rawConfig, schema),
    checkListLength(typed.value, schema),
    checkUnique(typed.value, schema),
    checkOneOf(rawConfig, schema),
    checkPattern(rawConfig, schema),
    checkRequiredTogether(rawConfig, requiredTogetherGroups),
    checkMutuallyExclusive(rawConfig, mutuallyExclusiveGroups),
    checkRequiredIf(rawConfig, schema),
  ];

  const errors = [];
  for (const result of results) {
    if (!result.ok) errors.push(...result.errors);
  }
  // Array.prototype.sort is a stable sort, so two errors already concatenated
  // for the same path keep the order they were pushed in.
  errors.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));

  return errors.length
    ? { ok: false, stage: 'constraints', errors }
    : { ok: true, value: typed.value };
}
