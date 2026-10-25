// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapter } from '../adapters/reference/index.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { LIMITS } from '../lib/limits.mjs';

test('capabilities: shortPages only for a scan budget of at most LIMITS.shortPagesBudgetMax rows', async () => {
  const at = (budgetRows) => createAdapter({ clock: createVirtualClock(), budgetRows });
  assert.equal((await at(LIMITS.shortPagesBudgetMax)).capabilities.shortPages, true);
  assert.equal((await at(LIMITS.shortPagesBudgetMax + 1)).capabilities.shortPages, false);
  assert.equal((await at(1)).capabilities.shortPages, true);
});

test('capabilities: shortPages false with the default scan budget; later features false', async () => {
  const full = await createAdapter({ clock: createVirtualClock() });
  assert.equal(full.capabilities.shortPages, false);
  assert.equal(full.capabilities.virtualClock, true);
  assert.equal(full.capabilities.subjectV1, false);
  assert.equal(full.capabilities.indexBuildStates, true);
  assert.equal(full.capabilities.eventualIndexLists, false);
  const short = await createAdapter({ clock: createVirtualClock(), budgetRows: 3 });
  assert.equal(short.capabilities.shortPages, true);
  await assert.rejects(() => createAdapter({ budgetRows: 0 }), TypeError);
});

test('createStore gives kvc-<n> ids; other ids are FORBIDDEN (403)', async () => {
  const adapter = await createAdapter({ clock: createVirtualClock() });
  const { storeId, identity } = await adapter.admin.createStore({ format: 2 });
  assert.match(storeId, /^kvc-\d+$/);
  assert.deepEqual(identity, { org: identity.org, store: storeId });
  await assert.rejects(adapter.kvStore.get('kvc-999', 'k'), (e) => e.code === 'FORBIDDEN' && e.status === 403);
  await adapter.admin.dispose();
  await assert.rejects(adapter.kvStore.get(storeId, 'k'), (e) => e.code === 'FORBIDDEN');
});

test('warn hears unknown set and delete options; the write goes ahead', async () => {
  const heard = [];
  const adapter = await createAdapter({ clock: createVirtualClock(), warn: (m) => heard.push(m) });
  const { storeId } = await adapter.admin.createStore();
  assert.equal(await adapter.kvStore.set(storeId, 'k', 1, { mode: 'x' }), true);
  assert.equal(await adapter.kvStore.delete(storeId, 'k', { other: 1 }), true);
  assert.equal(heard.length, 2);
  assert.match(heard[0], /mode/);
});

test('storage hook: a second adapter restores the stores, the allow-list and the store counter', async () => {
  let saved = null;
  const storage = { load: () => saved, save: (snap) => { saved = JSON.parse(JSON.stringify(snap)); } };
  const clock = createVirtualClock();
  const first = await createAdapter({ clock, storage });
  const { storeId } = await first.admin.createStore();
  await first.kvStore.set(storeId, 'k', { a: 1 }, { secret: true });
  const second = await createAdapter({ clock, storage });
  assert.deepEqual(await second.kvStore.get(storeId, 'k'), { a: 1 });
  const next = await second.admin.createStore();
  assert.notEqual(next.storeId, storeId);
});

test('control.setClock moves server time; injectFault refuses an unknown op', async () => {
  const clock = createVirtualClock();
  const adapter = await createAdapter({ clock });
  await adapter.control.setClock(clock.now() + 5000);
  assert.equal(adapter.backend.now(), clock.now() + 5000);
  await assert.rejects(adapter.control.injectFault({ op: 'get', when: 'before' }), (e) => e.code === 'VALIDATION');
});
