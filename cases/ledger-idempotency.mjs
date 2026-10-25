// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// ledger/idempotency: replays, the replay window, key reuse, append options and lost responses.
import assert from 'node:assert/strict';
import { allKeys, expectValidation } from './core-util.mjs';
import { COLLECTION, LEDGER, declare, ledgerCase } from './ledger-util.mjs';

const headSeq = async (ctx) => (await ctx.kv.ledgerStatus(LEDGER)).headSeq;
const entryCount = async (ctx, collection = COLLECTION) => (await allKeys(ctx.kv.list({ collection }))).length;

async function idempotentReplay(ctx) {
  await declare(ctx);
  const key = ctx.uniqueKey('evt');
  const first = await ctx.kv.append(COLLECTION, { action: 'login' }, { idempotencyKey: key });
  assert.notEqual(first.replayed, true);
  const before = await headSeq(ctx);
  const again = await ctx.kv.append(COLLECTION, { action: 'login' }, { idempotencyKey: key });
  assert.equal(again.replayed, true, 'replayed: true');
  for (const field of ['key', 'id', 'shard', 'seq', 'hash', 'prevHash']) {
    assert.equal(again[field], first[field], `same ${field}`);
  }
  assert.equal(await headSeq(ctx), before, 'no new entry');
}

async function replayWindow(ctx) {
  await declare(ctx);
  const key = ctx.uniqueKey('evt');
  const first = await ctx.kv.append(COLLECTION, { a: 1 }, { idempotencyKey: key });
  await ctx.clock.advance(ctx.limits.idempotencyKey.replayWindowMs + 1000);
  const later = await ctx.kv.append(COLLECTION, { a: 1 }, { idempotencyKey: key });
  assert.notEqual(later.replayed, true, 'after the window the key appends again');
  assert.notEqual(later.id, first.id, 'a new entry');
  assert.equal(await entryCount(ctx), 2);
}

async function keyReuseConflict(ctx) {
  await declare(ctx, { collection: `${COLLECTION}:*` });
  const key = ctx.uniqueKey('evt');
  await ctx.kv.append(`${COLLECTION}:a`, { n: 1 }, { idempotencyKey: key });
  await expectValidation(ctx, [
    () => ctx.kv.append(`${COLLECTION}:a`, { n: 2 }, { idempotencyKey: key }),
    () => ctx.kv.append(`${COLLECTION}:b`, { n: 1 }, { idempotencyKey: key }),
  ], 'idempotencyKey reused for another entry');
  assert.equal(await entryCount(ctx, `${COLLECTION}:a`), 1);
  assert.equal(await entryCount(ctx, `${COLLECTION}:b`), 0);
}

async function badIdempotencyKey(ctx) {
  await declare(ctx);
  const bad = ['', 'a:b', 'has space', 'x'.repeat(ctx.limits.idempotencyKey.maxLength + 1), 42];
  await expectValidation(ctx, bad.map((idempotencyKey) => () => ctx.kv.append(COLLECTION, { a: 1 }, { idempotencyKey })),
    'bad idempotencyKey');
  assert.equal(await entryCount(ctx), 0);
}

async function unknownOption(ctx) {
  await declare(ctx);
  await expectValidation(ctx, [
    () => ctx.kv.append(COLLECTION, { a: 1 }, { foo: 1 }),
    () => ctx.kv.append(COLLECTION, { a: 1 }, { ttl: ctx.limits.ttl.min }),
    () => ctx.kv.append(COLLECTION, { a: 1 }, 'options'),
  ], 'append option');
  assert.equal(await entryCount(ctx), 0);
}

async function lostAppendWithKey(ctx) {
  await declare(ctx);
  const key = ctx.uniqueKey('evt');
  await ctx.control.injectFault({ op: 'append', when: 'after-write' });
  await ctx.expectKVError(() => ctx.kv.append(COLLECTION, { a: 1 }, { idempotencyKey: key }),
    { code: 'UNAVAILABLE', retryable: true, details: { idempotencyKey: key } });
  const retry = await ctx.kv.append(COLLECTION, { a: 1 }, { idempotencyKey: key });
  assert.equal(retry.replayed, true, 'the retry returns the first receipt');
  assert.equal(await entryCount(ctx), 1, 'one entry');
}

async function lostAppendWithoutKey(ctx) {
  await declare(ctx);
  await ctx.control.injectFault({ op: 'append', when: 'after-write' });
  await ctx.expectKVError(() => ctx.kv.append(COLLECTION, { a: 1 }),
    { code: 'UNAVAILABLE', retryable: false, details: { idempotencyKey: ctx.limits.idempotencyKey.autoPattern } });
  assert.equal(await entryCount(ctx), 1, 'the entry was written');
}

const CLOCK = { needs: ['virtualClock'] };
const FAULT = { needs: ['injectFault'] };

export const ledgerIdempotencyCases = [
  ledgerCase('idempotent-replay', idempotentReplay),
  ledgerCase('replay-window', replayWindow, CLOCK),
  ledgerCase('key-reuse-conflict', keyReuseConflict),
  ledgerCase('bad-idempotencyKey', badIdempotencyKey),
  ledgerCase('unknown-option', unknownOption),
  ledgerCase('lost-append-with-key', lostAppendWithKey, FAULT),
  ledgerCase('lost-append-without-key', lostAppendWithoutKey, FAULT),
];
