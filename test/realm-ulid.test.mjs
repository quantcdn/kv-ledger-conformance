// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Parity with the platform: ULID versions, plain objects from another realm (node:vm), the FORBIDDEN text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createAdapter } from '../adapters/reference/index.mjs';
import { createUlid, ULID_PATTERN } from '../adapters/reference/backend/ulid.mjs';
import { isPlainObject } from '../lib/check-util.mjs';

test('ulid: 26 Crockford base32 characters, time first', () => {
  const ulid = createUlid();
  const id = ulid(Date.UTC(2026, 9, 28));
  assert.match(id, ULID_PATTERN);
  assert.equal(id.slice(0, 10), '01M5ZWWY00', 'the platform encodeTime gives the same prefix');
  assert.throws(() => ulid(-1), RangeError);
  assert.throws(() => ulid(2 ** 48), RangeError);
});

test('ulid: monotonic in one millisecond and when the clock moves back', () => {
  const ulid = createUlid();
  const ids = [ulid(1000), ulid(1000), ulid(1000), ulid(999), ulid(1001)];
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[3].slice(0, 10), ids[0].slice(0, 10), 'a clock that moves back keeps the last time');
});

test('the backend gives ULID versions', async () => {
  const adapter = await createAdapter();
  const { storeId } = await adapter.admin.createStore();
  const store = adapter.kvStore.open(storeId);
  await store.set('a', 1);
  await store.set('a', 2);
  assert.match((await store.getEntry('a')).version, ULID_PATTERN);
});

test('isPlainObject accepts plain objects from another realm, and nothing else from it', () => {
  const ctx = vm.createContext({});
  const run = (code) => vm.runInContext(code, ctx);
  assert.equal(isPlainObject(run('({ a: 1 })')), true);
  assert.equal(isPlainObject(run('Object.create(null)')), true);
  assert.equal(isPlainObject(run('[1]')), false);
  assert.equal(isPlainObject(run('new Date()')), false);
  assert.equal(isPlainObject(run('new (class A {})()')), false);
  assert.equal(isPlainObject(run('new Map()')), false);
  assert.equal(isPlainObject(Object.create(Object.create(null))), false);
  assert.equal(isPlainObject(Object.create({ constructor: function Object() {} })), false);
});

test('a function in a node:vm context can use kvStore with its own object literals', async () => {
  const adapter = await createAdapter();
  const { storeId } = await adapter.admin.createStore();
  await adapter.admin.declareIndex(storeId, { name: 'byT', collection: 'item', fields: ['t'] });
  const ctx = vm.createContext({ kvStore: adapter.kvStore, storeId });
  const out = await vm.runInContext(`(async () => {
    const s = kvStore.open(storeId);
    await s.set('item:1', { t: 'a', n: [1, 2] }, { ttl: 600 });
    const page = await s.list({ index: 'byT', equals: { t: 'a' } });
    const tx = await s.atomic().set('item:2', { t: 'b' }).commit({ idempotencyKey: 'k1' });
    return { value: await s.get('item:1'), keys: page.items.map((i) => i.key), tx: Object.keys(tx.versions) };
  })()`, ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { value: { t: 'a', n: [1, 2] }, keys: ['item:1'], tx: ['item:2'] });
});

test('FORBIDDEN has the runtime text', async () => {
  const adapter = await createAdapter();
  await assert.rejects(adapter.kvStore.get('other', 'k'),
    (err) => err.code === 'FORBIDDEN' && err.message === 'Access to KV store other is not allowed');
});
