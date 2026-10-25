// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVirtualClock, createRealClock } from '../lib/clock.mjs';

test('virtual clock starts at 2026-10-25 UTC by default', () => {
  const c = createVirtualClock();
  assert.equal(c.virtual, true);
  assert.equal(c.now(), Date.UTC(2026, 9, 25));
});

test('advance and set move time', async () => {
  const c = createVirtualClock(1000);
  await c.advance(500);
  assert.equal(c.now(), 1500);
  c.set(42);
  assert.equal(c.now(), 42);
});

test('advance rejects negative and non-finite values', async () => {
  const c = createVirtualClock(0);
  for (const bad of [-1, NaN, Infinity, -Infinity, '5', undefined]) {
    await assert.rejects(() => c.advance(bad), RangeError, String(bad));
  }
  assert.equal(c.now(), 0);
});

test('real clock sleeps', async () => {
  const c = createRealClock();
  assert.equal(c.virtual, false);
  const before = Date.now();
  await c.advance(20);
  assert.ok(c.now() - before >= 15);
});
