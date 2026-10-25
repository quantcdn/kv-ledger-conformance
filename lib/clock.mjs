// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Clocks for the suite: a virtual one that moves only on advance(), and a real one that waits.
export function createVirtualClock(startMs = Date.UTC(2026, 9, 25)) {
  let current = startMs;
  return {
    virtual: true,
    now: () => current,
    async advance(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
        throw new RangeError('advance needs a finite, non-negative number of milliseconds');
      }
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}

export function createRealClock() {
  return {
    virtual: false,
    now: () => Date.now(),
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
