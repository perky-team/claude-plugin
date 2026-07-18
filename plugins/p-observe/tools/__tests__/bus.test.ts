import { describe, expect, it } from 'vitest';
import { createBus } from '../lib/bus.mjs';

describe('createBus', () => {
  it('delivers pushed events to subscribers', () => {
    const bus = createBus({ size: 10 });
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.ts));
    bus.push({ ts: 1 }); bus.push({ ts: 2 });
    expect(seen).toEqual([1, 2]);
  });
  it('bounds the ring buffer to size, evicting oldest', () => {
    const bus = createBus({ size: 2 });
    bus.push({ ts: 1 }); bus.push({ ts: 2 }); bus.push({ ts: 3 });
    expect(bus.snapshot().map((e) => e.ts)).toEqual([2, 3]);
  });
  it('unsubscribe stops delivery', () => {
    const bus = createBus({ size: 10 });
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.ts));
    bus.push({ ts: 1 }); off(); bus.push({ ts: 2 });
    expect(seen).toEqual([1]);
  });
});
