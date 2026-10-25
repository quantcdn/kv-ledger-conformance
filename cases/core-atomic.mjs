// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/atomic: the transaction builder, checks, idempotency and a lost response.
import assert from 'node:assert/strict';
import { coreCase, expectValidation } from './core-util.mjs';

const FAULT = { needs: ['injectFault'] };

async function commitAll({ kv, uniqueKey }) {
  const [a, b, n] = [uniqueKey('a'), uniqueKey('b'), uniqueKey('n')];
  const result = await kv.atomic().set(a, 1).set(b, { x: 2 }).increment(n).commit();
  assert.equal(result.replayed, false);
  for (const key of [a, b, n]) assert.equal(typeof result.versions[key], 'string', `version of ${key}`);
  assert.equal(await kv.get(a), 1);
  assert.deepEqual(await kv.get(b), { x: 2 });
  assert.equal(await kv.get(n), 1);
  assert.equal(result.versions[a], (await kv.getEntry(a)).version);
}

async function checkFails(ctx) {
  const [a, b, c] = [ctx.uniqueKey('a'), ctx.uniqueKey('b'), ctx.uniqueKey('c')];
  await ctx.kv.set(b, 1);
  const { version } = await ctx.kv.getEntry(b);
  await ctx.kv.set(b, 2);
  const commit = () => ctx.kv.atomic().set(a, 1).check(b, version).set(c, 3).commit();
  await ctx.expectKVError(commit, { code: 'CONFLICT', status: 409, retryable: false, details: { operation: 1 } });
  assert.equal(await ctx.kv.get(a), null, 'nothing written');
  assert.equal(await ctx.kv.get(c), null, 'nothing written');
}

async function checkNullAbsent(ctx) {
  const [absent, present, target] = [ctx.uniqueKey('absent'), ctx.uniqueKey('present'), ctx.uniqueKey('t')];
  await ctx.kv.set(present, 1);
  await ctx.kv.atomic().check(absent, null).set(target, 1).commit();
  assert.equal(await ctx.kv.get(target), 1);
  const commit = () => ctx.kv.atomic().check(present, null).set(target, 2).commit();
  await ctx.expectKVError(commit, { code: 'CONFLICT', status: 409, details: { operation: 0 } });
  assert.equal(await ctx.kv.get(target), 1);
}

async function secondCommit(ctx) {
  const builder = ctx.kv.atomic().set(ctx.uniqueKey('a'), 1);
  await builder.commit();
  await expectValidation(ctx, [() => builder.commit()], 'second commit');
}

const counterTx = (kv, key, idempotencyKey) => kv.atomic().increment(key).commit({ idempotencyKey });

async function idempotentReplay({ kv, uniqueKey }) {
  const [key, idem] = [uniqueKey('n'), uniqueKey('idem')];
  const first = await counterTx(kv, key, idem);
  const again = await counterTx(kv, key, idem);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(await kv.get(key), 1, 'the counter moved once');
}

async function sameKeyDifferentOps(ctx) {
  const [a, idem] = [ctx.uniqueKey('a'), ctx.uniqueKey('idem')];
  await ctx.kv.atomic().set(a, 1).commit({ idempotencyKey: idem });
  await expectValidation(ctx, [() => ctx.kv.atomic().set(a, 2).commit({ idempotencyKey: idem })], 'reuse');
  assert.equal(await ctx.kv.get(a), 1);
}

async function badIdempotencyKey(ctx) {
  // keyMaxBytes characters is well over the idempotencyKey length limit.
  const tooLong = 'k'.repeat(ctx.limits.keyMaxBytes);
  const keys = ['has space', 'semi;colon', '', tooLong, 42];
  await expectValidation(ctx,
    keys.map((idempotencyKey) => () => ctx.kv.atomic().set(ctx.uniqueKey('a'), 1).commit({ idempotencyKey })), 'key');
}

async function bounds(ctx) {
  // A runtime may refuse at the call that goes over the limit or at commit: both are inside the closure.
  const tooMany = () => {
    const many = ctx.kv.atomic();
    for (let i = 0; i <= ctx.limits.transaction.maxOps; i += 1) many.set(`k${i}`, i);
    return many.commit();
  };
  await expectValidation(ctx, [() => ctx.kv.atomic().commit(), tooMany], 'bounds');
  assert.equal(await ctx.kv.get('k0'), null);
}

async function duplicateKey(ctx) {
  const key = ctx.uniqueKey('dup');
  await expectValidation(ctx, [() => ctx.kv.atomic().set(key, 1).set(key, 2).commit()], 'duplicate');
  assert.equal(await ctx.kv.get(key), null);
}

async function unknownCommitOption(ctx) {
  const key = ctx.uniqueKey('a');
  await expectValidation(ctx, [() => ctx.kv.atomic().set(key, 1).commit({ bogus: 1 })], 'commit option');
  assert.equal(await ctx.kv.get(key), null);
}

async function lostResponseWithKey(ctx) {
  const [key, idem] = [ctx.uniqueKey('n'), ctx.uniqueKey('idem')];
  await ctx.control.injectFault({ op: 'commit', when: 'after-write' });
  await ctx.expectKVError(() => counterTx(ctx.kv, key, idem), { code: 'UNAVAILABLE', retryable: true });
  const retry = await counterTx(ctx.kv, key, idem);
  assert.equal(retry.replayed, true);
  assert.equal(await ctx.kv.get(key), 1, 'the counter moved once');
}

async function lostResponseWithoutKey(ctx) {
  const key = ctx.uniqueKey('n');
  await ctx.control.injectFault({ op: 'commit', when: 'after-write' });
  await ctx.expectKVError(() => ctx.kv.atomic().increment(key).commit(), { code: 'UNAVAILABLE', retryable: false });
  assert.equal(await ctx.kv.get(key), 1, 'the write happened');
}

export const coreAtomicCases = [
  coreCase('atomic/commit-all', commitAll),
  coreCase('atomic/check-fails', checkFails),
  coreCase('atomic/check-null-absent', checkNullAbsent),
  coreCase('atomic/second-commit', secondCommit),
  coreCase('atomic/idempotent-replay', idempotentReplay),
  coreCase('atomic/same-key-different-ops', sameKeyDifferentOps),
  coreCase('atomic/bad-idempotencyKey', badIdempotencyKey),
  coreCase('atomic/bounds', bounds),
  coreCase('atomic/duplicate-key', duplicateKey),
  coreCase('atomic/unknown-commit-option', unknownCommitOption),
  coreCase('atomic/lost-response-with-key', lostResponseWithKey, FAULT),
  coreCase('atomic/lost-response-without-key', lostResponseWithoutKey, FAULT),
];
