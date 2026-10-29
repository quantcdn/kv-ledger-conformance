// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import { createAdapter } from '../adapters/reference/index.mjs';
import { createPersistence } from '../adapters/reference/backend/persist.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';

const KVError = createKVErrorClass();
const raw = (v) => JSON.stringify(v);
const KEYS = createLocalBackend({ clock: createVirtualClock() }).snapshot().keys;

// A shared "file" with a lock and a change counter, as quant serve keeps one on disk.
function createDisk() {
  const disk = { data: null, rev: 0, locked: false, maxHeld: 0 };
  disk.storage = () => {
    let seen = -1;
    const load = () => {
      seen = disk.rev;
      return disk.data === null ? null : JSON.parse(disk.data);
    };
    return {
      load,
      changed: () => disk.rev !== seen,
      async transaction(run) {
        while (disk.locked) await new Promise((resolve) => setImmediate(resolve));
        disk.locked = true;
        try {
          const next = await run(load());
          await new Promise((resolve) => setImmediate(resolve));
          disk.data = JSON.stringify(next);
          disk.rev += 1;
          seen = disk.rev;
        } finally {
          disk.locked = false;
        }
      },
    };
  };
  return disk;
}

function makeBackend(disk, clock = createVirtualClock()) {
  return createLocalBackend({ clock, KVError, keys: KEYS, storage: disk.storage() });
}

test('with storage.transaction, writes return promises and save the snapshot', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  const created = a.createStore({ id: 's', format: 2 });
  assert.ok(created instanceof Promise);
  assert.deepEqual(await created, { id: 's', format: 2 });
  await a.put('s', 'k', raw({ n: 1 }));
  assert.equal(JSON.parse(disk.data).stores[0].items[0][0], 'k');
});

test('a second backend sees the writes of the first through changed()', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  const b = makeBackend(disk);
  await a.createStore({ id: 's', format: 2 });
  await a.put('s', 'k', raw({ n: 1 }));
  assert.deepEqual(b.storeIds(), ['s']);
  assert.equal(b.get('s', 'k').raw, raw({ n: 1 }));
});

test('two backends that write at the same time lose no write', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  const b = makeBackend(disk);
  await a.createStore({ id: 's', format: 2 });
  const writes = [];
  for (let i = 0; i < 20; i += 1) writes.push((i % 2 ? a : b).increment('s', 'counter', 1));
  await Promise.all(writes);
  assert.equal(a.get('s', 'counter').raw, '20');
  assert.equal(b.get('s', 'counter').raw, '20');
});

test('the writes of one backend run in the order of the calls', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  await a.createStore({ id: 's', format: 2 });
  const order = [];
  await Promise.all([1, 2, 3].map((n) => a.put('s', 'k', raw(n)).then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(a.get('s', 'k').raw, '3');
});

test('a write that throws rejects with its KVError and still saves', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  await a.createStore({ id: 's', format: 2 });
  await a.put('s', 'k', raw(1));
  const rev = disk.rev;
  await assert.rejects(a.put('s', 'k', raw(2), { ifAbsent: true }), (err) => err instanceof KVError && err.code === 'CONFLICT');
  assert.equal(disk.rev, rev + 1);
  await a.put('s', 'k2', raw(1));
});

test('a transaction that does not run the write rejects', async () => {
  const backend = createLocalBackend({
    clock: createVirtualClock(),
    storage: { load: () => null, transaction: async () => {} },
  });
  await assert.rejects(backend.createStore({ id: 's', format: 2 }), /did not run the write/);
});

test('without the new hooks, writes stay synchronous', () => {
  const saved = [];
  const backend = createLocalBackend({ clock: createVirtualClock(), storage: { load: () => null, save: (s) => saved.push(s) } });
  assert.deepEqual(backend.createStore({ id: 's', format: 2 }), { id: 's', format: 2 });
  assert.deepEqual(backend.put('s', 'k', raw(1)).version.length > 0, true);
  assert.equal(saved.length, 2);
});

const BY_T = { name: 'byT', collection: 'item', fields: ['t'] };
const listByT = (backend) => backend.query('s', { index: 'byT', equals: { t: 'a' } }, { search: false }).items.map((i) => i.key);

function indexed(indexes) {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError, indexes });
  backend.createStore({ id: 's', format: 2 });
  return { backend, clock };
}

test('the index settings are checked', () => {
  const clock = createVirtualClock();
  for (const indexes of [{ initialState: 'FAILED' }, { activationMs: -1 }, { listLagMs: 1.5 }]) {
    assert.throws(() => createLocalBackend({ clock, indexes }), TypeError);
  }
});

test("initialState 'ACTIVE' makes an index ACTIVE at once, also with wait false", () => {
  const { backend } = indexed({ initialState: 'ACTIVE' });
  assert.equal(backend.declareIndex('s', BY_T, { wait: false }).state, 'ACTIVE');
  backend.put('s', 'item:1', raw({ t: 'a' }));
  assert.deepEqual(listByT(backend), ['item:1']);
});

test("initialState 'ACTIVE' still runs the backfill check", () => {
  const { backend } = indexed({ initialState: 'ACTIVE' });
  backend.put('s', 'item:1', raw({ e: 'x' }));
  backend.put('s', 'item:2', raw({ e: 'x' }));
  const result = backend.declareIndex('s', { name: 'byE', collection: 'item', fields: ['e'], unique: true }, { wait: false });
  assert.deepEqual(result, { name: 'byE', state: 'FAILED', error: 'UNIQUE_VIOLATION' });
});

test('activationMs sets the BUILDING time', async () => {
  const { backend, clock } = indexed({ activationMs: 1000 });
  backend.declareIndex('s', BY_T, { wait: false });
  assert.throws(() => listByT(backend), (err) => err.code === 'INDEX_NOT_READY');
  await clock.advance(1000);
  assert.deepEqual(listByT(backend), []);
});

test('listLagMs leaves a new write out of index lists, but not out of getBy or count', async () => {
  const { backend, clock } = indexed({ listLagMs: 500 });
  backend.declareIndex('s', { ...BY_T, unique: true });
  backend.declareIndex('s', { name: 'cnt', collection: 'item', fields: ['t'], count: true });
  backend.put('s', 'item:1', raw({ t: 'a' }));
  assert.deepEqual(listByT(backend), []);
  assert.equal(backend.lookup('s', 'byT', { t: 'a' }).key, 'item:1');
  assert.equal(backend.count('s', { index: 'cnt', equals: { t: 'a' } }), 1);
  await clock.advance(500);
  assert.deepEqual(listByT(backend), ['item:1']);
});

test('setIndexState holds the state until the next call', async () => {
  const { backend, clock } = indexed({});
  backend.declareIndex('s', BY_T);
  assert.deepEqual(backend.setIndexState('s', 'byT', 'BUILDING'), { name: 'byT', state: 'BUILDING' });
  await clock.advance(10 * 60 * 1000);
  assert.throws(() => listByT(backend), (err) => err.code === 'INDEX_NOT_READY' && err.state === 'BUILDING');
  backend.setIndexState('s', 'byT', 'FAILED');
  assert.throws(() => listByT(backend), (err) => err.code === 'INDEX_NOT_READY' && err.state === 'FAILED');
  backend.setIndexState('s', 'byT', 'ACTIVE');
  assert.deepEqual(listByT(backend), []);
});

test('setIndexState checks the state and the index', () => {
  const { backend } = indexed({});
  backend.declareIndex('s', BY_T);
  assert.throws(() => backend.setIndexState('s', 'byT', 'DONE'), TypeError);
  assert.throws(() => backend.setIndexState('s', 'nope', 'ACTIVE'), (err) => err.code === 'NOT_FOUND');
});

test('a held index state survives a snapshot', async () => {
  const { backend, clock } = indexed({});
  backend.declareIndex('s', BY_T);
  backend.setIndexState('s', 'byT', 'BUILDING');
  const copy = createLocalBackend({ clock, KVError });
  copy.restore(backend.snapshot());
  await clock.advance(10 * 60 * 1000);
  assert.throws(() => copy.query('s', { index: 'byT', equals: { t: 'a' } }, { search: false }), (err) => err.code === 'INDEX_NOT_READY');
});

test('the adapter passes the index settings and has control.setIndexState', async () => {
  const lag = await createAdapter({ indexes: { listLagMs: 100 } });
  assert.equal(lag.capabilities.eventualIndexLists, true);
  assert.equal(lag.capabilities.indexBuildStates, true);
  const active = await createAdapter({ indexes: { initialState: 'ACTIVE' } });
  assert.equal(active.capabilities.eventualIndexLists, false);
  assert.equal(active.capabilities.indexBuildStates, false);
  const { storeId } = await active.admin.createStore();
  await active.admin.declareIndex(storeId, BY_T, { wait: false });
  assert.deepEqual(await active.control.setIndexState(storeId, 'byT', 'FAILED'), { name: 'byT', state: 'FAILED' });
});

test('the adapter works with storage.transaction', async () => {
  const disk = createDisk();
  const adapter = await createAdapter({ storage: disk.storage(), keys: KEYS });
  const { storeId } = await adapter.admin.createStore();
  const store = adapter.kvStore.open(storeId);
  await store.set('item:1', { t: 'a' });
  assert.deepEqual(await store.get('item:1'), { t: 'a' });
  const again = await createAdapter({ storage: disk.storage(), keys: KEYS });
  assert.deepEqual(again.backend.storeIds(), [storeId]);
});

test('a read during a write does not undo the write (review 1)', async () => {
  const disk = createDisk();
  const a = makeBackend(disk);
  const b = makeBackend(disk);
  await a.createStore({ id: 's', format: 2 });
  await b.put('s', 'fromB', raw(1));
  const write = a.put('s', 'fromA', raw(2));
  assert.equal(a.get('s', 'fromB'), null, 'no reload while the write is in flight');
  await write;
  assert.equal(a.get('s', 'fromA').raw, raw(2));
  assert.equal(a.get('s', 'fromB').raw, raw(1));
});

// A sync disk: save and load, with a change counter for changed().
function createSyncDisk() {
  const disk = { data: null, rev: 0, failSave: false };
  disk.storage = () => {
    let seen = -1;
    return {
      load() {
        seen = disk.rev;
        return disk.data === null ? null : JSON.parse(disk.data);
      },
      save(snapshot) {
        if (disk.failSave) throw new Error('disk full');
        disk.data = JSON.stringify(snapshot);
        disk.rev += 1;
        seen = disk.rev;
      },
      changed: () => disk.rev !== seen,
    };
  };
  return disk;
}

test('with save and changed, a write reloads first and loses no other write (review 2)', () => {
  const disk = createSyncDisk();
  const clock = createVirtualClock();
  const a = createLocalBackend({ clock, KVError, keys: KEYS, storage: disk.storage() });
  const b = createLocalBackend({ clock, KVError, keys: KEYS, storage: disk.storage() });
  a.createStore({ id: 's', format: 2 });
  a.put('s', 'a', raw(1));
  b.put('s', 'b', raw(2));
  a.put('s', 'c', raw(3));
  const keys = JSON.parse(disk.data).stores[0].items.map(([key]) => key).sort();
  assert.deepEqual(keys, ['a', 'b', 'c']);
});

test('a failed save puts the memory back to the disk state (review 3)', async () => {
  const sync = createSyncDisk();
  const backend = createLocalBackend({ clock: createVirtualClock(), KVError, keys: KEYS, storage: sync.storage() });
  backend.createStore({ id: 's', format: 2 });
  sync.failSave = true;
  assert.throws(() => backend.put('s', 'k', raw(1)), /disk full/);
  assert.equal(backend.get('s', 'k'), null);
  assert.throws(() => backend.createStore({ id: 't', format: 2 }), /disk full/);
  assert.deepEqual(backend.storeIds(), ['s']);

  const disk = createDisk();
  const storage = disk.storage();
  const a = createLocalBackend({ clock: createVirtualClock(), KVError, keys: KEYS, storage });
  await a.createStore({ id: 's', format: 2 });
  const transaction = storage.transaction;
  storage.transaction = async (run) => {
    await run(storage.load());
    throw new Error('rename failed');
  };
  await assert.rejects(a.put('s', 'k', raw(1)), /rename failed/);
  assert.equal(a.get('s', 'k'), null);
  storage.transaction = transaction;
  await a.put('s', 'k2', raw(1));
  assert.equal(a.get('s', 'k2').raw, raw(1));
});

test('setClock is a write, so the next write keeps it (review 4)', async () => {
  const disk = createDisk();
  const clock = createVirtualClock();
  const a = makeBackend(disk, clock);
  await a.createStore({ id: 's', format: 2 });
  await a.setClock(clock.now() + 3600000);
  await a.put('s', 'k', raw(1));
  assert.equal(a.now(), clock.now() + 3600000);
});

test('storage needs load and save or transaction (review 8)', () => {
  const clock = createVirtualClock();
  assert.throws(() => createLocalBackend({ clock, storage: { load: () => null, changed: () => false } }), /save\(\) or transaction\(\)/);
  assert.throws(() => createLocalBackend({ clock, storage: { save: () => {} } }), /load\(\)/);
});

test('index settings ignore undefined values (review 9)', () => {
  const { backend } = indexed({ initialState: undefined, activationMs: undefined, listLagMs: undefined });
  assert.equal(backend.declareIndex('s', BY_T, { wait: false }).state, 'BUILDING');
});

test('a write with a storage hook takes one snapshot (the one it saves), not a second copy for a failed save', async () => {
  const counting = () => {
    const state = { snapshots: 0, data: { n: 0 } };
    state.snapshot = () => {
      state.snapshots += 1;
      return { ...state.data };
    };
    state.restore = (data) => {
      state.data = { ...data };
    };
    return state;
  };
  const perWrite = async (persisted, state) => {
    const before = state.snapshots;
    await persisted(() => { state.data.n += 1; });
    return state.snapshots - before;
  };

  // save: the first write on an empty disk also keeps a copy to fall back on; after that, one snapshot per write.
  const sync = counting();
  let disk = null;
  const saving = createPersistence({ load: () => disk, save: (s) => { disk = s; } }, sync);
  saving.start();
  assert.equal(await perWrite(saving.persisted, sync), 2, 'empty disk: the fallback copy and the save');
  assert.deepEqual([await perWrite(saving.persisted, sync), await perWrite(saving.persisted, sync)], [1, 1]);
  const loaded = counting();
  const fromDisk = createPersistence({ load: () => disk, save: (s) => { disk = s; } }, loaded);
  fromDisk.start();
  assert.equal(await perWrite(fromDisk.persisted, loaded), 1, 'a loaded disk state is the fallback');
  fromDisk.forget();
  assert.equal(await perWrite(fromDisk.persisted, loaded), 2, 'after a restore from outside, a copy again');

  // transaction: the fresh snapshot is the fallback, so one snapshot per write once the disk has a state.
  const tx = counting();
  let shared = null;
  const transacting = createPersistence({ load: () => shared, async transaction(run) { shared = await run(shared); } }, tx);
  transacting.start();
  assert.equal(await perWrite(transacting.persisted, tx), 2, 'empty disk');
  assert.deepEqual([await perWrite(transacting.persisted, tx), await perWrite(transacting.persisted, tx)], [1, 1]);
  assert.equal(shared.n, 3);

  // A failed save still goes back to the disk state, from the fallback when load gives null.
  const failing = counting();
  let fail = false;
  let kept = null;
  const flaky = createPersistence({ load: () => (fail ? null : kept), save: (s) => {
    if (fail) throw new Error('disk full');
    kept = s;
  } }, failing);
  await perWrite(flaky.persisted, failing);
  fail = true;
  assert.throws(() => flaky.persisted(() => { failing.data.n += 1; }), /disk full/);
  assert.equal(failing.data.n, 1, 'back to the state last saved');
});

test('backend.ledgers and backend.indexes list the declarations, brought up to the clock, as copies', async () => {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError });
  assert.throws(() => backend.ledgers('none'), (err) => err.code === 'STORE_NOT_FOUND');
  assert.throws(() => backend.indexes('none'), (err) => err.code === 'STORE_NOT_FOUND');
  backend.createStore({ id: 's', format: 2 });
  assert.deepEqual(backend.ledgers('s'), []);
  assert.deepEqual(backend.indexes('s'), []);
  const declared = backend.declareLedger('s', { name: 'audit', collection: 'audit', chains: 1, retentionDays: 1,
    personalFields: ['email'], subjectField: 'userId' }, { wait: false });
  backend.declareIndex('s', { name: 'byT', collection: 'item', fields: ['t'] }, { wait: false });
  backend.put('s', 'bad:1', raw({ u: 1 }));
  backend.declareIndex('s', { name: 'uniq', collection: 'bad', fields: ['u'], unique: true });
  backend.put('s', 'dup:1', raw({ u: 1 }));
  backend.put('s', 'dup:2', raw({ u: 1 }));
  backend.declareIndex('s', { name: 'dupe', collection: 'dup', fields: ['u'], unique: true });

  const [ledger] = backend.ledgers('s');
  assert.deepEqual(ledger, { name: 'audit', state: 'PENDING', activeAfter: declared.activeAfter,
    definition: declared.definition });
  assert.equal(ledger.definition.subjectMode, 'pseudonym');
  assert.deepEqual(ledger.definition.personalFields, ['email']);
  assert.deepEqual(backend.indexes('s'), [
    { name: 'byT', state: 'BUILDING', definition: { name: 'byT', collection: 'item', fields: ['t'], unique: false, count: false } },
    { name: 'uniq', state: 'ACTIVE', definition: { name: 'uniq', collection: 'bad', fields: ['u'], unique: true, count: false } },
    { name: 'dupe', state: 'FAILED', error: 'UNIQUE_VIOLATION',
      definition: { name: 'dupe', collection: 'dup', fields: ['u'], unique: true, count: false } },
  ]);

  await clock.advance(10 * 60 * 1000);
  assert.deepEqual(backend.ledgers('s').map((l) => [l.state, Object.hasOwn(l, 'activeAfter')]), [['ACTIVE', false]]);
  assert.equal(backend.indexes('s')[0].state, 'ACTIVE');

  const copy = backend.ledgers('s')[0];
  copy.definition.personalFields.push('x');
  copy.state = 'DROPPED';
  backend.indexes('s')[0].definition.fields.push('x');
  assert.deepEqual(backend.ledgers('s')[0].definition.personalFields, ['email'], 'a copy');
  assert.equal(backend.ledgers('s')[0].state, 'ACTIVE');
  assert.deepEqual(backend.indexes('s')[0].definition.fields, ['t'], 'a copy');
});

test('backend.ledgers and backend.indexes reload a changed snapshot first', () => {
  const disk = createSyncDisk();
  const clock = createVirtualClock();
  const a = createLocalBackend({ clock, KVError, keys: KEYS, storage: disk.storage() });
  const b = createLocalBackend({ clock, KVError, keys: KEYS, storage: disk.storage() });
  a.createStore({ id: 's', format: 2 });
  a.declareLedger('s', { name: 'audit', collection: 'audit', chains: 1, retentionDays: 1 });
  a.declareIndex('s', { name: 'byT', collection: 'item', fields: ['t'] });
  assert.deepEqual(b.ledgers('s').map((l) => [l.name, l.state]), [['audit', 'ACTIVE']]);
  assert.deepEqual(b.indexes('s').map((i) => [i.name, i.state]), [['byT', 'ACTIVE']]);
});
