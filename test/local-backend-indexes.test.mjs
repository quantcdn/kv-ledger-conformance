// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS } from '../lib/limits.mjs';

const KVError = createKVErrorClass();
const raw = (v) => JSON.stringify(v);

function make() {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError });
  backend.createStore({ id: 's1', format: 2 });
  return { backend, clock };
}

function throwsCode(fn, code, check = () => {}) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof KVError, `KVError, got ${err}`);
    assert.equal(err.code, code, err.message);
    check(err);
    return true;
  });
}

const UNIQUE = { name: 'byEmail', collection: 'user', fields: ['email'], unique: true };
const COUNT = { name: 'perCustomer', collection: 'customer:*:world', fields: ['customerId'], count: true };

test('declareIndex validates the definition', () => {
  const { backend } = make();
  const bad = [
    { ...UNIQUE, name: '1x' },
    { ...UNIQUE, fields: [] },
    { ...UNIQUE, count: true },
    { ...UNIQUE, fields: ['a', 'b', 'c', 'd'] },
    { ...UNIQUE, fields: ['bad-name'] },
    { ...UNIQUE, collection: 'a::b' },
    { ...UNIQUE, collection: 7 },
    { ...UNIQUE, sortBy: 'x y' },
  ];
  for (const def of bad) throwsCode(() => backend.declareIndex('s1', def, { wait: true }), 'VALIDATION');
  backend.declareIndex('s1', UNIQUE, { wait: true });
  throwsCode(() => backend.declareIndex('s1', UNIQUE, { wait: true }), 'VALIDATION');
});

test('declareIndex refuses more than the per-collection and per-store counts', () => {
  const { backend } = make();
  const plain = (i, collection) => ({ name: `i${i}`, collection, fields: [] });
  for (let i = 0; i < LIMITS.indexesPerCollection; i += 1) backend.declareIndex('s1', plain(i, 'c0'), { wait: true });
  throwsCode(() => backend.declareIndex('s1', plain(99, 'c0'), { wait: true }), 'LIMIT_EXCEEDED');
  for (let i = LIMITS.indexesPerCollection; i < LIMITS.indexesPerStore; i += 1) {
    backend.declareIndex('s1', plain(i, `c${i}`), { wait: true });
  }
  throwsCode(() => backend.declareIndex('s1', plain(98, 'other'), { wait: true }), 'LIMIT_EXCEEDED');
});

test('BUILDING until the activation delay; wait makes it ACTIVE now', async () => {
  const { backend, clock } = make();
  assert.equal(backend.declareIndex('s1', UNIQUE, { wait: false }).state, 'BUILDING');
  throwsCode(() => backend.lookup('s1', 'byEmail', { email: 'a' }), 'INDEX_NOT_READY', (e) => {
    assert.equal(e.retryable, true);
    assert.equal(e.index, 'byEmail');
    assert.equal(e.state, 'BUILDING');
    assert.equal(e.status, 409);
  });
  await clock.advance(LIMITS.indexActivationMs);
  assert.equal(backend.lookup('s1', 'byEmail', { email: 'a' }), null);
  assert.equal(backend.declareIndex('s1', { ...COUNT }, { wait: true }).state, 'ACTIVE');
});

test('a backfill that finds a clash ends FAILED; drop removes the index', () => {
  const { backend } = make();
  backend.put('s1', 'user:1', raw({ email: 'a' }), {});
  backend.put('s1', 'user:2', raw({ email: 'a' }), {});
  const result = backend.declareIndex('s1', UNIQUE, { wait: true });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error, 'UNIQUE_VIOLATION');
  throwsCode(() => backend.lookup('s1', 'byEmail', { email: 'a' }), 'INDEX_NOT_READY');
  backend.dropIndex('s1', 'byEmail');
  throwsCode(() => backend.lookup('s1', 'byEmail', { email: 'a' }), 'NOT_FOUND');
  throwsCode(() => backend.dropIndex('s1', 'byEmail'), 'NOT_FOUND');
});

test('unique: violation names the owner; an expired owner releases the value', async () => {
  const { backend, clock } = make();
  backend.declareIndex('s1', UNIQUE, { wait: true });
  backend.put('s1', 'user:1', raw({ email: 'a' }), { ttl: LIMITS.ttl.min });
  throwsCode(() => backend.put('s1', 'user:2', raw({ email: 'a' }), {}), 'UNIQUE_VIOLATION', (e) => {
    assert.equal(e.existingKey, 'user:1');
    assert.equal(e.index, 'byEmail');
  });
  throwsCode(() => backend.transact('s1', [{ op: 'set', key: 'user:3', raw: raw({ email: 'a' }) }], {}),
    'UNIQUE_VIOLATION');
  await clock.advance(LIMITS.ttl.min * 1000);
  backend.put('s1', 'user:2', raw({ email: 'a' }), {});
  assert.equal(backend.lookup('s1', 'byEmail', { email: 'a' }).key, 'user:2');
});

test('count: groups, typed equals, ttl refused, getBy/count kind rules', () => {
  const { backend } = make();
  backend.declareIndex('s1', COUNT, { wait: true });
  backend.declareIndex('s1', UNIQUE, { wait: true });
  backend.put('s1', 'customer:a:world:1', raw({ customerId: 1 }), {});
  backend.put('s1', 'customer:b:world:1', raw({ customerId: '1' }), {});
  assert.equal(backend.count('s1', { index: 'perCustomer', equals: { customerId: 1 } }), 1);
  throwsCode(() => backend.put('s1', 'customer:c:world:1', raw({ customerId: 2 }), { ttl: LIMITS.ttl.min }), 'COUNT_WITH_TTL');
  throwsCode(() => backend.count('s1', { index: 'byEmail', equals: { email: 'a' } }), 'VALIDATION');
  throwsCode(() => backend.lookup('s1', 'perCustomer', { customerId: 1 }), 'VALIDATION');
  throwsCode(() => backend.count('s1', { index: 'perCustomer', equals: { other: 1 } }), 'VALIDATION');
});

test('secret and increment in an indexed collection are refused', () => {
  const { backend } = make();
  backend.declareIndex('s1', UNIQUE, { wait: true });
  throwsCode(() => backend.put('s1', 'user:9', raw({ email: 'x' }), { secret: true }), 'INDEX_FIELD_ENCRYPTED');
  throwsCode(() => backend.increment('s1', 'user:n', 1, {}), 'VALIDATION');
  throwsCode(() => backend.transact('s1', [{ op: 'increment', key: 'user:m', amount: 1 }], {}), 'VALIDATION');
  backend.increment('s1', 'other:n', 1, {});
});

test('list by index: sortBy order, missing sortBy first, bounds exclusive, reverse, cursor across pages', () => {
  const { backend } = make();
  backend.declareIndex('s1', { name: 'byStatus', collection: 'task', fields: ['status'], sortBy: 'rank' }, { wait: true });
  const rows = { 'task:a': 3, 'task:b': 1, 'task:c': 2, 'task:e': undefined };
  for (const [key, rank] of Object.entries(rows)) backend.put('s1', key, raw({ status: 'open', rank }), {});
  backend.put('s1', 'task:d', raw({ status: 'closed', rank: 0 }), {});
  const q = (o) => backend.query('s1', { index: 'byStatus', equals: { status: 'open' }, ...o }, { search: false });
  assert.deepEqual(q({}).items.map((i) => i.key), ['task:e', 'task:b', 'task:c', 'task:a']);
  assert.deepEqual(q({ reverse: true }).items.map((i) => i.key), ['task:a', 'task:c', 'task:b', 'task:e']);
  assert.deepEqual(q({ after: 1, before: 3 }).items.map((i) => i.key), ['task:c']);
  const first = q({ limit: 2 });
  assert.equal(first.indexed, true);
  assert.deepEqual(q({ limit: 2, cursor: first.cursor }).items.map((i) => i.key), ['task:c', 'task:a']);
  throwsCode(() => q({ equals: { other: 'x' } }), 'VALIDATION');
});

test('indexes survive snapshot and restore', () => {
  const { backend, clock } = make();
  backend.declareIndex('s1', UNIQUE, { wait: true });
  backend.put('s1', 'user:1', raw({ email: 'a' }), {});
  const other = createLocalBackend({ clock, KVError });
  other.restore(JSON.parse(JSON.stringify(backend.snapshot())));
  assert.equal(other.lookup('s1', 'byEmail', { email: 'a' }).key, 'user:1');
  throwsCode(() => other.put('s1', 'user:2', raw({ email: 'a' }), {}), 'UNIQUE_VIOLATION');
});
