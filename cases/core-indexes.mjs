// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/indexes: unique lookups, counts, lists by index and what an index refuses. Indexes are declared with
// ctx.admin.declareIndex (outside the edge surface).
import assert from 'node:assert/strict';
import { allKeys, coreCase, eventually, expectValidation } from './core-util.mjs';

const BY_EMAIL = { name: 'byEmail', collection: 'user', fields: ['email'], unique: true };
const BY_STATUS = { name: 'byStatus', collection: 'task', fields: ['status'], sortBy: 'rank' };
const BY_CUSTOMER = { name: 'worldsByCustomer', collection: 'customer:*:world', fields: ['customerId'], count: true };
const ALL_WORLDS = { name: 'allWorlds', collection: 'customer:*:world', fields: [], count: true };

const declare = (ctx, ...defs) => Promise.all(defs.map((def) => ctx.admin.declareIndex(ctx.storeId, def, { wait: true })));

async function uniqueGetBy(ctx) {
  await declare(ctx, BY_EMAIL);
  await ctx.kv.set('user:1', { email: 'a@example.com', name: 'A' });
  const entry = await ctx.kv.getBy('byEmail', { email: 'a@example.com' });
  assert.equal(entry.key, 'user:1');
  assert.deepEqual(entry.value, { email: 'a@example.com', name: 'A' });
  assert.equal(await ctx.kv.getBy('byEmail', { email: 'nobody@example.com' }), null);
}

async function uniqueViolation(ctx) {
  await declare(ctx, BY_EMAIL);
  await ctx.kv.set('user:1', { email: 'a@example.com' });
  await ctx.expectKVError(() => ctx.kv.set('user:2', { email: 'a@example.com' }),
    { code: 'UNIQUE_VIOLATION', status: 409, retryable: false, details: { index: 'byEmail', existingKey: 'user:1' } });
  assert.equal(await ctx.kv.get('user:2'), null, 'nothing written');
  assert.equal(await ctx.kv.set('user:1', { email: 'a@example.com', n: 2 }), true, 'the owner may write its value again');
}

async function count(ctx) {
  await declare(ctx, BY_CUSTOMER, ALL_WORLDS);
  await ctx.kv.set('customer:c1:world:w1', { customerId: 'c1' });
  await ctx.kv.set('customer:c1:world:w2', { customerId: 'c1' });
  await ctx.kv.set('customer:c2:world:w1', { customerId: 'c2' });
  await ctx.kv.set('customer:c2:other:x', { customerId: 'c2' });
  assert.equal(await ctx.kv.count({ index: 'worldsByCustomer', equals: { customerId: 'c1' } }), 2);
  assert.equal(await ctx.kv.count({ index: 'worldsByCustomer', equals: { customerId: 'c3' } }), 0);
  assert.equal(await ctx.kv.count({ index: 'allWorlds' }), 3);
  assert.equal(await ctx.kv.count({ index: 'allWorlds', equals: {} }), 3);
  await ctx.kv.delete('customer:c1:world:w2');
  assert.equal(await ctx.kv.count({ index: 'worldsByCustomer', equals: { customerId: 'c1' } }), 1);
}

async function countWithTtl(ctx) {
  await declare(ctx, ALL_WORLDS);
  const key = 'customer:c1:world:w1';
  await ctx.expectKVError(() => ctx.kv.set(key, { customerId: 'c1' }, { ttl: ctx.limits.ttl.min }),
    { code: 'COUNT_WITH_TTL', status: 400, retryable: false });
  assert.equal(await ctx.kv.get(key), null);
}

async function secretInIndexed(ctx) {
  await declare(ctx, BY_EMAIL);
  await ctx.expectKVError(() => ctx.kv.set('user:9', { email: 's@example.com' }, { secret: true }),
    { code: 'INDEX_FIELD_ENCRYPTED', status: 400, retryable: false });
  assert.equal(await ctx.kv.get('user:9'), null);
}

const TASKS = {
  'task:a': { status: 'open', rank: 3 },
  'task:b': { status: 'open', rank: 1 },
  'task:c': { status: 'open', rank: 2 },
  'task:d': { status: 'closed', rank: 0 },
  'task:e': { status: 'open' },
};

async function listByIndex(ctx) {
  await declare(ctx, BY_STATUS);
  for (const [key, value] of Object.entries(TASKS)) await ctx.kv.set(key, value);
  const list = (options) => allKeys(ctx.kv.list({ index: 'byStatus', equals: { status: 'open' }, limit: 2, ...options }));
  await eventually(ctx, async () => {
    const open = await list({});
    // An item with no sortBy value sorts first, then ascending sortBy values.
    assert.deepEqual(open, ['task:e', 'task:b', 'task:c', 'task:a']);
    assert.ok(!open.includes('task:d'), 'equals selects the group');
    assert.deepEqual(await list({ reverse: true }), [...open].reverse());
    assert.deepEqual(await list({ after: 1, before: 3 }), ['task:c'], 'after and before are exclusive');
  });
}

// Items with the same sortBy value come back in key order; an index without sortBy lists in key order.
async function listTieOrder(ctx) {
  await declare(ctx, BY_STATUS, { name: 'byKind', collection: 'item', fields: ['kind'] });
  for (const id of ['c', 'a', 'b']) await ctx.kv.set(`task:${id}`, { status: 'open', rank: 1 });
  for (const id of ['z', 'x', 'y']) await ctx.kv.set(`item:${id}`, { kind: 'k' });
  await eventually(ctx, async () => {
    const tied = await allKeys(ctx.kv.list({ index: 'byStatus', equals: { status: 'open' }, limit: 2 }));
    assert.deepEqual(tied, ['task:a', 'task:b', 'task:c'], 'same sortBy value: key order');
    const plain = await allKeys(ctx.kv.list({ index: 'byKind', equals: { kind: 'k' }, limit: 2 }));
    assert.deepEqual(plain, ['item:x', 'item:y', 'item:z'], 'no sortBy: key order');
  });
}

// equals is type-exact: n: 1 does not match n: '1'.
async function equalsTypeExact(ctx) {
  await declare(ctx, { name: 'byN', collection: 'num', fields: ['n'] });
  await ctx.kv.set('num:int', { n: 1 });
  await ctx.kv.set('num:text', { n: '1' });
  await eventually(ctx, async () => {
    assert.deepEqual(await allKeys(ctx.kv.list({ index: 'byN', equals: { n: 1 } })), ['num:int']);
    assert.deepEqual(await allKeys(ctx.kv.list({ index: 'byN', equals: { n: '1' } })), ['num:text']);
  });
}

async function getByNonUnique(ctx) {
  await declare(ctx, BY_STATUS);
  await ctx.expectKVError(() => ctx.kv.getBy('byStatus', { status: 'open' }), { code: 'VALIDATION', retryable: false });
}

async function countNonCount(ctx) {
  await declare(ctx, BY_EMAIL);
  await ctx.expectKVError(() => ctx.kv.count({ index: 'byEmail', equals: { email: 'a@example.com' } }),
    { code: 'VALIDATION', retryable: false });
}

// An index that is not declared: VALIDATION with the platform text, for getBy, count and a list by index.
async function unknownIndex(ctx) {
  const noIndex = (err) => assert.match(err.message, /^No index named nope\b/, 'the message names the index');
  const expected = { code: 'VALIDATION', retryable: false };
  noIndex(await ctx.expectKVError(() => ctx.kv.getBy('nope', { email: 'a@example.com' }), expected));
  noIndex(await ctx.expectKVError(() => ctx.kv.count({ index: 'nope', equals: {} }), expected));
  noIndex(await ctx.expectKVError(() => ctx.kv.list({ index: 'nope', equals: {} }), expected));
}

async function notReady(ctx) {
  await ctx.admin.declareIndex(ctx.storeId, BY_EMAIL, { wait: false });
  const expected = { code: 'INDEX_NOT_READY', retryable: true, details: { index: 'byEmail' } };
  await ctx.expectKVError(() => ctx.kv.getBy('byEmail', { email: 'a@example.com' }), expected);
  await ctx.expectKVError(() => ctx.kv.list({ index: 'byEmail', equals: { email: 'a@example.com' } }), expected);
  await ctx.clock.advance(ctx.limits.indexActivationMs + 1000);
  assert.equal(await ctx.kv.getBy('byEmail', { email: 'a@example.com' }), null, 'ACTIVE after the build delay');
}

async function incrementIndexed(ctx) {
  await declare(ctx, { name: 'byN', collection: 'ctr', fields: ['n'] });
  // Only increment() is sourced as refused in an indexed collection; atomic().increment is not asserted.
  await expectValidation(ctx, [() => ctx.kv.increment('ctr:x')], 'increment in an indexed collection');
  assert.equal(await ctx.kv.get('ctr:x'), null);
}

async function equalsBounds(ctx) {
  await declare(ctx, BY_EMAIL, ALL_WORLDS);
  const four = { a: 1, b: 2, c: 3, d: 4 };
  await expectValidation(ctx, [
    () => ctx.kv.getBy('byEmail', four),
    () => ctx.kv.count({ index: 'allWorlds', equals: four }),
    () => ctx.kv.list({ index: 'byEmail', equals: four }),
    () => ctx.kv.getBy('1bad', { email: 'a' }),
    () => ctx.kv.count({ index: 'bad-name' }),
    () => ctx.kv.list({ index: 'bad name' }),
  ], 'equals and index name');
}

const DECLARES = { declares: ['index'] };
const SECRET = { ...DECLARES, needs: ['secretEncryption'] };
const BUILD = { ...DECLARES, needs: ['indexBuildStates', 'virtualClock'] };

export const coreIndexCases = [
  coreCase('indexes/unique-getBy', uniqueGetBy, DECLARES),
  coreCase('indexes/unique-violation', uniqueViolation, DECLARES),
  coreCase('indexes/count', count, DECLARES),
  coreCase('indexes/count-with-ttl', countWithTtl, DECLARES),
  coreCase('indexes/secret-in-indexed', secretInIndexed, SECRET),
  coreCase('indexes/list-by-index', listByIndex, DECLARES),
  coreCase('indexes/list-tie-order', listTieOrder, DECLARES),
  coreCase('indexes/equals-type-exact', equalsTypeExact, DECLARES),
  coreCase('indexes/getBy-non-unique', getByNonUnique, DECLARES),
  coreCase('indexes/count-non-count', countNonCount, DECLARES),
  coreCase('indexes/not-ready', notReady, BUILD),
  coreCase('indexes/unknown-index', unknownIndex, DECLARES),
  coreCase('indexes/increment-indexed', incrementIndexed, DECLARES),
  coreCase('indexes/equals-bounds', equalsBounds, DECLARES),
];
