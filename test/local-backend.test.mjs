// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS } from '../lib/limits.mjs';

const KVError = createKVErrorClass();

function make(options = {}) {
  const clock = options.clock || createVirtualClock();
  const backend = createLocalBackend({ clock, KVError, ...options });
  backend.createStore({ id: 's1', format: 2 });
  return { backend, clock };
}

async function rejects(promiseOrFn, code, check = () => {}) {
  await assert.rejects(async () => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn), (err) => {
    assert.ok(err instanceof KVError, `KVError, got ${err}`);
    assert.equal(err.code, code);
    check(err);
    return true;
  });
}

const raw = (v) => JSON.stringify(v);

test('put, get and remove; every write gives a new version', async () => {
  const { backend } = make();
  const a = await backend.put('s1', 'k', raw({ a: 1 }), {});
  const b = await backend.put('s1', 'k', raw({ a: 2 }), {});
  assert.notEqual(a.version, b.version);
  const rec = await backend.get('s1', 'k');
  assert.equal(rec.raw, raw({ a: 2 }));
  assert.equal(rec.version, b.version);
  assert.equal(rec.encrypted, false);
  assert.equal(await backend.remove('s1', 'k', {}), true);
  assert.equal(await backend.get('s1', 'k'), null);
});

test('an unknown store is STORE_NOT_FOUND (404)', async () => {
  const { backend } = make();
  await rejects(() => backend.get('nope', 'k'), 'STORE_NOT_FOUND', (e) => assert.equal(e.status, 404));
});

test('conditional writes: exists, version, missing, expired', async () => {
  const { backend, clock } = make();
  const { version } = await backend.put('s1', 'k', raw(1), {});
  await rejects(() => backend.put('s1', 'k', raw(2), { ifAbsent: true }), 'CONFLICT', (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.reason, 'exists');
    assert.equal(e.key, 'k');
  });
  await backend.put('s1', 'k', raw(3), {});
  await rejects(() => backend.put('s1', 'k', raw(4), { ifVersion: version }), 'CONFLICT', (e) => {
    assert.equal(e.reason, 'version');
    assert.equal(typeof e.currentVersion, 'string');
  });
  await rejects(() => backend.remove('s1', 'gone', { ifVersion: version }), 'CONFLICT', (e) => assert.equal(e.reason, 'missing'));
  const t = await backend.put('s1', 't', raw(1), { ttl: LIMITS.ttl.min });
  await clock.advance(LIMITS.ttl.min * 1000);
  await rejects(() => backend.put('s1', 't', raw(2), { ifVersion: t.version }), 'CONFLICT', (e) => assert.equal(e.reason, 'expired'));
  assert.equal(typeof (await backend.put('s1', 't', raw(2), { ifAbsent: true })).version, 'string');
});

test('ttl: expired keys read as null; a rewrite without ttl clears it', async () => {
  const { backend, clock } = make();
  await backend.put('s1', 'a', raw(1), { ttl: LIMITS.ttl.min });
  await backend.put('s1', 'b', raw(1), { ttl: LIMITS.ttl.min });
  await backend.put('s1', 'b', raw(2), {});
  assert.equal(typeof (await backend.get('s1', 'a')).expiresAt, 'number');
  await clock.advance(LIMITS.ttl.min * 1000 + 1);
  assert.equal(await backend.get('s1', 'a'), null);
  assert.deepEqual((await backend.batchGet('s1', ['a', 'b'])).map((r) => r && r.raw), [null, raw(2)]);
});

test('increment: new, ttl kept on a live counter, not numeric, range', async () => {
  const { backend } = make();
  assert.equal(await backend.increment('s1', 'n', 1, { ttl: LIMITS.ttl.min }), 1);
  const { expiresAt } = await backend.get('s1', 'n');
  assert.equal(await backend.increment('s1', 'n', 5, {}), 6);
  assert.equal((await backend.get('s1', 'n')).expiresAt, expiresAt);
  await backend.put('s1', 'o', raw({ a: 1 }), {});
  await rejects(() => backend.increment('s1', 'o', 1, {}), 'CONFLICT', (e) => assert.equal(e.reason, 'not_numeric'));
  await backend.put('s1', 'm', raw(Number.MAX_SAFE_INTEGER), {});
  await rejects(() => backend.increment('s1', 'm', 1, {}), 'CONFLICT', (e) => assert.equal(e.reason, 'range'));
});

test('secret values are sealed at rest and opened on read', async () => {
  const { backend } = make();
  await backend.put('s1', 'sec', raw({ token: 'plain-text-token' }), { secret: true });
  const rec = await backend.get('s1', 'sec');
  assert.equal(rec.encrypted, true);
  assert.equal(rec.raw, raw({ token: 'plain-text-token' }));
  assert.ok(!JSON.stringify(backend.snapshot().stores).includes('plain-text-token'), 'no plaintext at rest');
  await rejects(() => backend.increment('s1', 'sec', 1, {}), 'CONFLICT');
  const page = await backend.query('s1', { prefix: 's', includeValues: true }, { search: false });
  assert.equal(page.items[0].value, '[ENCRYPTED]');
  assert.equal(page.items[0].encrypted, true);
});

test('item size over the limit is LIMIT_EXCEEDED', async () => {
  const { backend } = make();
  await rejects(() => backend.put('s1', 'big', raw('x'.repeat(LIMITS.itemMaxBytes)), {}), 'LIMIT_EXCEEDED');
  assert.equal(await backend.get('s1', 'big'), null);
});

test('transact: all or nothing, operation index, idempotent replay, key reuse', async () => {
  const { backend } = make();
  const ops = [{ op: 'set', key: 'a', raw: raw(1) }, { op: 'check', key: 'b', version: 'v-x' }];
  await rejects(() => backend.transact('s1', ops, {}), 'CONFLICT', (e) => assert.equal(e.operation, 1));
  assert.equal(await backend.get('s1', 'a'), null);
  const tx = [{ op: 'set', key: 'a', raw: raw(1) }, { op: 'increment', key: 'n', amount: 2 }, { op: 'check', key: 'z', version: null }];
  const first = await backend.transact('s1', tx, { idempotencyKey: 'k1' });
  assert.equal(first.replayed, false);
  assert.deepEqual(Object.keys(first.versions).sort(), ['a', 'n']);
  const again = await backend.transact('s1', tx, { idempotencyKey: 'k1' });
  assert.equal(again.replayed, true);
  assert.equal((await backend.get('s1', 'n')).raw, '2');
  await rejects(() => backend.transact('s1', [{ op: 'set', key: 'a', raw: raw(9) }], { idempotencyKey: 'k1' }), 'VALIDATION');
});

async function seed(backend, n, prefix = 'k') {
  for (let i = 0; i < n; i += 1) await backend.put('s1', `${prefix}${String(i).padStart(2, '0')}`, raw(i), {});
}

test('query: pages, cursors, scan budget and the end', async () => {
  const { backend } = make({ budgetRows: 3 });
  await seed(backend, 7);
  const first = await backend.query('s1', { prefix: 'k', limit: 10 }, { search: false });
  assert.equal(first.items.length, 3);
  assert.equal(first.pageEnd, 'budget');
  assert.equal(first.hasMore, true);
  const keys = first.items.map((i) => i.key);
  let page = first;
  while (page.hasMore) {
    page = await backend.query('s1', { prefix: 'k', limit: 10, cursor: page.cursor }, { search: false });
    keys.push(...page.items.map((i) => i.key));
  }
  assert.equal(page.cursor, null);
  assert.equal(page.pageEnd, 'end');
  assert.deepEqual(keys, ['k00', 'k01', 'k02', 'k03', 'k04', 'k05', 'k06']);
});

test('query: cursors are bound to the query and the store, and expire', async () => {
  const { backend, clock } = make();
  backend.createStore({ id: 's2', format: 2 });
  await seed(backend, 3);
  const { cursor } = await backend.query('s1', { prefix: 'k', limit: 1 }, { search: false });
  await rejects(() => backend.query('s1', { prefix: 'k0', limit: 1, cursor }, { search: false }), 'CURSOR_INVALID');
  await rejects(() => backend.query('s2', { prefix: 'k', limit: 1, cursor }, { search: false }), 'CURSOR_INVALID');
  await rejects(() => backend.query('s1', { prefix: 'k', cursor: 'junk' }, { search: false }), 'CURSOR_INVALID');
  const next = await backend.query('s1', { prefix: 'k', limit: 2, cursor }, { search: false });
  assert.deepEqual(next.items.map((i) => i.key), ['k01', 'k02']);
  await clock.advance(LIMITS.cursorLifetimeMs + 1);
  await rejects(() => backend.query('s1', { prefix: 'k', cursor }, { search: false }), 'CURSOR_INVALID', (e) => assert.equal(e.status, 400));
});

test('query: the page byte budget ends a page early but keeps one item', async () => {
  const { backend } = make();
  const big = 'v'.repeat(Math.floor(LIMITS.itemMaxBytes * 0.9));
  const count = Math.ceil(LIMITS.pageBytesBudget / big.length) + 1;
  for (let i = 0; i < count; i += 1) await backend.put('s1', `b${String(i).padStart(2, '0')}`, raw(big), {});
  const page = await backend.query('s1', { prefix: 'b', includeValues: true, limit: 1000 }, { search: false });
  assert.equal(page.pageEnd, 'bytes');
  assert.equal(page.hasMore, true);
  assert.ok(page.items.length >= 1 && page.items.length < count);
});

test('query: collections in UTF-8 byte order, nested keys excluded, where and pattern on search', async () => {
  const { backend } = make();
  for (const k of ['c:\u{1F600}', 'c:\uFF5E', 'c:b', 'c:a:x', 'root']) await backend.put('s1', k, raw({ k }), {});
  const col = await backend.query('s1', { collection: 'c' }, { search: false });
  assert.deepEqual(col.items.map((i) => i.key), ['c:b', 'c:\uFF5E', 'c:\u{1F600}']);
  assert.equal(col.indexed, true);
  const rev = await backend.query('s1', { collection: 'c', reverse: true }, { search: false });
  assert.deepEqual(rev.items.map((i) => i.key), ['c:\u{1F600}', 'c:\uFF5E', 'c:b']);
  const root = await backend.query('s1', { collection: '' }, { search: false });
  assert.deepEqual(root.items.map((i) => i.key), ['root']);
  const where = await backend.query('s1', { where: { k: 'c:b' } }, { search: true });
  assert.deepEqual(where.items.map((i) => i.key), ['c:b']);
  const pattern = await backend.query('s1', { pattern: 'c:*:x' }, { search: true });
  assert.deepEqual(pattern.items.map((i) => i.key), ['c:a:x']);
});

test('injectFault: before writes nothing; after-write writes and throws UNAVAILABLE', async () => {
  const { backend } = make();
  backend.injectFault({ op: 'set', when: 'before' });
  await rejects(() => backend.put('s1', 'k', raw(1), {}), 'UNAVAILABLE');
  assert.equal(await backend.get('s1', 'k'), null);
  backend.injectFault({ op: 'increment', when: 'after-write' });
  await rejects(() => backend.increment('s1', 'n', 1, {}), 'UNAVAILABLE', (e) => assert.equal(e.retryable, false));
  assert.equal((await backend.get('s1', 'n')).raw, '1');
  backend.injectFault({ op: 'commit', when: 'after-write' });
  await rejects(() => backend.transact('s1', [{ op: 'increment', key: 'n', amount: 1 }], { idempotencyKey: 'i' }),
    'UNAVAILABLE', (e) => assert.equal(e.retryable, true));
  assert.equal((await backend.transact('s1', [{ op: 'increment', key: 'n', amount: 1 }], { idempotencyKey: 'i' })).replayed, true);
  assert.equal((await backend.get('s1', 'n')).raw, '2');
});

test('setClock moves server time used for ttl', async () => {
  const { backend, clock } = make();
  backend.setClock(clock.now() + 3600000);
  assert.equal(backend.now(), clock.now() + 3600000);
  await backend.put('s1', 'k', raw(1), { ttl: LIMITS.ttl.min });
  assert.equal((await backend.get('s1', 'k')).expiresAt, clock.now() + 3600000 + LIMITS.ttl.min * 1000);
});

test('snapshot and restore round trip, including secret values and idempotency records', async () => {
  const { backend, clock } = make();
  await backend.put('s1', 'k', raw({ a: 1 }), { secret: true });
  await backend.transact('s1', [{ op: 'increment', key: 'n', amount: 1 }], { idempotencyKey: 'once' });
  const snap = JSON.parse(JSON.stringify(backend.snapshot()));
  const other = createLocalBackend({ clock, KVError });
  other.restore(snap);
  assert.deepEqual(other.storeIds(), ['s1']);
  assert.equal((await other.get('s1', 'k')).raw, raw({ a: 1 }));
  const replay = await other.transact('s1', [{ op: 'increment', key: 'n', amount: 1 }], { idempotencyKey: 'once' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(other.snapshot(), backend.snapshot());
});

test('storage hook: load at create, save after each write', async () => {
  const saved = [];
  const storage = { load: () => null, save: (snap) => saved.push(JSON.stringify(snap)) };
  const clock = createVirtualClock();
  const first = createLocalBackend({ clock, KVError, storage });
  first.createStore({ id: 's1', format: 2 });
  await first.put('s1', 'k', raw(1), {});
  assert.ok(saved.length >= 2, 'saved after createStore and put');
  const second = createLocalBackend({ clock, KVError, storage: { load: () => JSON.parse(saved.at(-1)), save: () => {} } });
  assert.equal((await second.get('s1', 'k')).raw, raw(1));
});

test('injectFault refuses unknown ops and times', async () => {
  const { backend } = make();
  for (const op of ['get', 'query']) {
    await rejects(() => backend.injectFault({ op, when: 'before' }), 'VALIDATION');
  }
  await rejects(() => backend.injectFault({ op: 'append', when: 'later' }), 'VALIDATION');
});
