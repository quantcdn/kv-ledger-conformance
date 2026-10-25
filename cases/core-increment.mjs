// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/increment: counters, amounts, ttl and a lost response.
import assert from 'node:assert/strict';
import { ERROR_CODES } from '../lib/error-contract.mjs';
import { coreCase, expectValidation } from './core-util.mjs';

const ANY_CODE = Object.keys(ERROR_CODES);

async function newCounter({ kv, uniqueKey }) {
  const key = uniqueKey('ctr');
  assert.equal(await kv.increment(key), 1);
  assert.equal(await kv.increment(key, 5), 6);
  assert.equal(await kv.get(key), 6);
}

async function badAmount(ctx) {
  const key = ctx.uniqueKey('ctr');
  await expectValidation(ctx, [0, 1.5, '1'].map((amount) => () => ctx.kv.increment(key, amount)), 'amount');
  assert.equal(await ctx.kv.get(key), null, 'nothing written');
}

// The reference adapter throws CONFLICT with reason 'not_numeric'; any not-retryable KVError passes.
async function notANumber(ctx) {
  const key = ctx.uniqueKey('obj');
  await ctx.kv.set(key, { a: 1 });
  await ctx.expectKVError(() => ctx.kv.increment(key), { code: ANY_CODE, retryable: false });
  assert.deepEqual(await ctx.kv.get(key), { a: 1 }, 'the value did not change');
}

async function ttlBounds(ctx) {
  const { min, max } = ctx.limits.ttl;
  const key = ctx.uniqueKey('ctr');
  await expectValidation(ctx, [min - 1, max + 1, min + 0.5].map((ttl) => () => ctx.kv.increment(key, 1, { ttl })), 'ttl');
  assert.equal(await ctx.kv.increment(key, 1, { ttl: min }), 1);
}

async function unknownOption(ctx) {
  const key = ctx.uniqueKey('ctr');
  await expectValidation(ctx, [() => ctx.kv.increment(key, 1, { bogus: 1 })], 'increment option');
  assert.equal(await ctx.kv.get(key), null);
}

async function lostResponse(ctx) {
  const key = ctx.uniqueKey('ctr');
  await ctx.control.injectFault({ op: 'increment', when: 'after-write' });
  await ctx.expectKVError(() => ctx.kv.increment(key), { code: 'UNAVAILABLE', retryable: false });
  assert.equal(await ctx.kv.get(key), 1, 'the counter moved once');
}

export const coreIncrementCases = [
  coreCase('increment/new-counter', newCounter),
  coreCase('increment/bad-amount', badAmount),
  coreCase('increment/not-a-number', notANumber),
  coreCase('increment/ttl-bounds', ttlBounds),
  coreCase('increment/unknown-option', unknownOption),
  coreCase('increment/lost-response', lostResponse, { needs: ['injectFault'] }),
];
