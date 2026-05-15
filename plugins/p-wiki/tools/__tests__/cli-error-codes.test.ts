import { describe, expect, it } from 'vitest';
import { mapErrorToCode } from '../pwiki.mjs';

describe('CLI error mapping', () => {
  it('401 → auth-failed', () => {
    expect(mapErrorToCode({ status: 401 })).toBe('auth-failed');
  });
  it('429 → rate-limited', () => {
    expect(mapErrorToCode({ status: 429 })).toBe('rate-limited');
  });
  it('5xx → network-error', () => {
    expect(mapErrorToCode({ status: 503 })).toBe('network-error');
  });
  it('409 → version-conflict', () => {
    expect(mapErrorToCode({ status: 409 })).toBe('version-conflict');
  });
  it('ECONNREFUSED → network-error', () => {
    expect(mapErrorToCode({ code: 'ECONNREFUSED' })).toBe('network-error');
  });
  it('unknown → internal', () => {
    expect(mapErrorToCode({})).toBe('internal');
  });
});
