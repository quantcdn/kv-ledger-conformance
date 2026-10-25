// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// ledger/values: what an append accepts, entry immutability and the reads of an entry.
import assert from 'node:assert/strict';
import { allKeys, expectValidation } from './core-util.mjs';
import { COLLECTION, LEDGER, declare, ledgerCase, linkOf } from './ledger-util.mjs';

const entryCount = async (ctx) => (await allKeys(ctx.kv.list({ collection: COLLECTION }))).length;

async function collectionBytes(ctx) {
  await declare(ctx);
  const long = 'c'.repeat(ctx.limits.ledgerCollectionMaxBytes + 1);
  await expectValidation(ctx, [() => ctx.kv.append(long, { a: 1 })], 'collection over the byte limit');
}

async function notObject(ctx) {
  await declare(ctx);
  await expectValidation(ctx, [[1], 'text', null, 7].map((value) => () => ctx.kv.append(COLLECTION, value)),
    'not an object');
  assert.equal(await entryCount(ctx), 0);
}

async function reservedFields(ctx) {
  await declare(ctx);
  await expectValidation(ctx, [
    () => ctx.kv.append(COLLECTION, { at: 1 }),
    () => ctx.kv.append(COLLECTION, { $event: 'shred' }),
    () => ctx.kv.append(COLLECTION, { f: { $enc: 'x' } }),
  ], 'reserved field');
  assert.equal(await entryCount(ctx), 0);
  const r = await ctx.kv.append(COLLECTION, { source: 'mine' });
  assert.equal((await ctx.kv.get(r.key)).source, 'mine', 'a field named source is the caller data');
}

// Bytes of the stored envelope without its source; the source only adds bytes.
const envelopeBytes = (value) => Buffer.byteLength(JSON.stringify({ type: 'plaintext', value }));
const padded = (target) => {
  const value = { pad: '' };
  value.pad = 'x'.repeat(target - envelopeBytes(value));
  return value;
};

async function valueSize(ctx) {
  await declare(ctx);
  const max = ctx.limits.ledgerValueMaxBytes;
  await ctx.expectKVError(() => ctx.kv.append(COLLECTION, padded(max + 1)),
    { code: 'LIMIT_EXCEEDED', retryable: false });
  assert.equal(await entryCount(ctx), 0);
  const r = await ctx.kv.append(COLLECTION, padded(max - 2000));
  assert.equal(r.seq, 1, 'a value 2,000 bytes under the limit is accepted');
}

const IMMUTABLE = { code: 'LEDGER_IMMUTABLE', status: 400, retryable: false };

async function immutable(ctx) {
  await declare(ctx);
  const r = await ctx.kv.append(COLLECTION, { a: 1 });
  await ctx.expectKVError(() => ctx.kv.set(r.key, { a: 2 }), IMMUTABLE);
  await ctx.expectKVError(() => ctx.kv.delete(r.key), IMMUTABLE);
  await ctx.expectKVError(() => ctx.kv.increment(r.key), IMMUTABLE);
  await ctx.expectKVError(() => ctx.kv.atomic().set(r.key, { a: 3 }).commit(), IMMUTABLE);
  const entry = await ctx.kv.getEntry(r.key);
  assert.equal(entry.value.a, 1, 'the entry is unchanged');
  assert.equal(entry.ledger.hash, r.hash);
}

async function getEntryLedgerBlock(ctx) {
  await declare(ctx, { chains: 2 });
  const value = { action: 'login', user: 'u1' };
  const r = await ctx.kv.append(COLLECTION, value);
  const entry = await ctx.kv.getEntry(r.key);
  assert.equal(entry.key, r.key);
  assert.equal(entry.value.action, 'login');
  assert.equal(entry.value.user, 'u1');
  assert.equal(entry.version, undefined, 'no version on a ledger entry');
  assert.equal(entry.ledger.name, LEDGER);
  assert.deepEqual(linkOf(entry.ledger), linkOf(r), 'the ledger block matches the receipt');
  assert.equal((await ctx.kv.get(r.key)).user, 'u1', 'get returns the value');
  const [many] = await ctx.kv.getMany([r.key]);
  assert.equal(many.ledger.hash, r.hash, 'getMany has the ledger block');
}

export const ledgerValueCases = [
  ledgerCase('collection-bytes', collectionBytes),
  ledgerCase('not-object', notObject),
  ledgerCase('reserved-fields', reservedFields),
  ledgerCase('value-size', valueSize),
  ledgerCase('immutable', immutable),
  ledgerCase('getEntry-ledger-block', getEntryLedgerBlock),
];
