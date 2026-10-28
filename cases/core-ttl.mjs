// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/ttl: ttl bounds, expiry on the clock, and the expiry-like option names.
import assert from 'node:assert/strict';
import { PAST_TTL_MS, allKeys, assertTime, coreCase, expectValidation } from './core-util.mjs';

const VIRTUAL = { needs: ['virtualClock'] };

async function ttlBounds(ctx) {
  const { min, max } = ctx.limits.ttl;
  const key = ctx.uniqueKey('ttl');
  await expectValidation(ctx, [min - 1, max + 1, min + 0.5].map((ttl) => () => ctx.kv.set(key, 1, { ttl })), 'ttl');
  assert.equal(await ctx.kv.set(key, 1, { ttl: min }), true);
  assert.equal(await ctx.kv.set(key, 2, { ttl: max }), true);
  assert.equal(await ctx.kv.get(key), 2);
}

async function ttlExpiresAt({ kv, uniqueKey, limits }) {
  const key = uniqueKey('exp');
  await kv.set(key, 1, { ttl: limits.ttl.min });
  const entry = await kv.getEntry(key);
  assertTime(entry.expiresAt, 'expiresAt');
}

// Writes key with the shortest ttl and moves the clock past it.
async function expiredKey({ kv, clock, limits }, key) {
  await kv.set(key, { v: 1 }, { ttl: limits.ttl.min });
  await clock.advance(PAST_TTL_MS);
}

async function expiredReads(ctx) {
  const prefix = ctx.uniqueKey('expired');
  const [gone, kept] = [`${prefix}-a`, `${prefix}-b`];
  await ctx.kv.set(kept, 1);
  await expiredKey(ctx, gone);
  assert.equal(await ctx.kv.get(gone), null, 'get');
  assert.equal(await ctx.kv.getEntry(gone), null, 'getEntry');
  assert.deepEqual((await ctx.kv.getMany([gone, kept])).map((e) => e && e.key), [null, kept], 'getMany');
  assert.deepEqual(await allKeys(ctx.kv.list({ prefix })), [kept], 'list');
}

async function ifAbsentOnExpired(ctx) {
  const key = ctx.uniqueKey('abs');
  await expiredKey(ctx, key);
  const result = await ctx.kv.set(key, 2, { ifAbsent: true });
  assert.equal(typeof result.version, 'string');
  assert.equal(await ctx.kv.get(key), 2);
}

async function ifVersionOnExpired(ctx) {
  const key = ctx.uniqueKey('ver');
  await ctx.kv.set(key, 1, { ttl: ctx.limits.ttl.min });
  const { version } = await ctx.kv.getEntry(key);
  await ctx.clock.advance(PAST_TTL_MS);
  await ctx.expectKVError(() => ctx.kv.set(key, 2, { ifVersion: version }),
    { code: 'CONFLICT', status: 409, retryable: false, details: { reason: 'expired' } });
}

async function rewriteClearsTtl(ctx) {
  const key = ctx.uniqueKey('re');
  await ctx.kv.set(key, 1, { ttl: ctx.limits.ttl.min });
  await ctx.kv.set(key, 2);
  await ctx.clock.advance(PAST_TTL_MS);
  assert.equal(await ctx.kv.get(key), 2, 'a write without ttl removes the expiry');
  const entry = await ctx.kv.getEntry(key);
  assert.ok(entry.expiresAt === undefined || entry.expiresAt === null, 'no expiresAt');
}

async function expiryLikeNames(ctx) {
  const key = ctx.uniqueKey('name');
  const expected = { code: 'VALIDATION', retryable: false, details: { hint: ctx.limits.expiryHint } };
  // The runtime's text: `Unknown <kind> option: <name>`.
  for (const name of ctx.limits.expiryOptionNames) {
    const set = await ctx.expectKVError(() => ctx.kv.set(key, 1, { [name]: ctx.limits.ttl.min }), expected);
    assert.equal(set.message, `Unknown set option: ${name}`);
    const del = await ctx.expectKVError(() => ctx.kv.delete(key, { [name]: ctx.limits.ttl.min }), expected);
    assert.equal(del.message, `Unknown delete option: ${name}`);
  }
  assert.equal(await ctx.kv.get(key), null, 'nothing written');
}

// Warn phase: an unknown name is ignored. Refuse phase: VALIDATION, with no expiry hint.
async function unknownOptionPhase(ctx) {
  const key = ctx.uniqueKey('mode');
  let result;
  try {
    result = await ctx.kv.set(key, 1, { mode: 'x' });
  } catch (err) {
    const checked = await ctx.expectKVError(Promise.reject(err), { code: 'VALIDATION', retryable: false });
    assert.equal(checked.hint, undefined, 'no expiry hint for a non-expiry name');
    return;
  }
  assert.equal(result, true);
  assert.equal(await ctx.kv.get(key), 1);
}

export const coreTtlCases = [
  coreCase('ttl/ttl-bounds', ttlBounds),
  coreCase('ttl/ttl-expiresAt', ttlExpiresAt),
  coreCase('ttl/expired-reads', expiredReads, VIRTUAL),
  coreCase('ttl/ifAbsent-on-expired', ifAbsentOnExpired, VIRTUAL),
  coreCase('ttl/ifVersion-on-expired', ifVersionOnExpired, VIRTUAL),
  coreCase('ttl/rewrite-clears-ttl', rewriteClearsTtl, VIRTUAL),
  coreCase('ttl/expiry-like-names', expiryLikeNames),
  coreCase('ttl/unknown-option-phase', unknownOptionPhase),
];
