// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The @quantcdn/edge-kv package (packages/edge-kv): the build copies every module it needs, byte for byte, and the
// package entry gives a working kvStore. The conformance suite tests the same bytes through the reference adapter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../scripts/build-edge-kv.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = join(ROOT, 'packages/edge-kv');
const files = build();

test('the build copies each module of the closure byte for byte', () => {
  assert.ok(files.includes('adapters/reference/backend/persist.mjs'));
  for (const file of files) {
    assert.ok(readFileSync(join(PKG, 'src', file)).equals(readFileSync(join(ROOT, file))), file);
  }
});

test('the package version follows the suite version', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  const suite = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version.replace(/-.*$/, ''), suite.version);
  assert.equal(pkg.license, suite.license);
});

test('npm pack ships the entry, the types and the modules, and nothing else', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PKG, encoding: 'utf8' });
  const shipped = JSON.parse(out)[0].files.map((f) => f.path).sort();
  const expected = ['LICENSE', 'NOTICE', 'README.md', 'index.d.ts', 'index.mjs', 'package.json', 'types/kvstore.d.ts',
    ...files.map((file) => `src/${file}`)].sort();
  assert.deepEqual(shipped, expected);
});

test('createLocalKv gives a kvStore with the edge checks and the allow-list', async () => {
  const { createLocalKv } = await import(join(PKG, 'index.mjs'));
  const { kvStore, backend } = createLocalKv({ indexes: { initialState: 'ACTIVE' } });
  backend.createStore({ id: 'site', format: 2 });
  const store = kvStore.open('site');
  await store.set('item:1', { t: 'a' }, { ttl: 600 });
  assert.deepEqual(await store.get('item:1'), { t: 'a' });
  await assert.rejects(kvStore.get('other', 'k'), (err) => err instanceof kvStore.KVError && err.code === 'FORBIDDEN');
  await assert.rejects(store.set('k', 1, { expiration: 5 }), (err) => err.code === 'VALIDATION' && err.hint === 'use ttl (seconds)');
  backend.declareIndex('site', { name: 'byT', collection: 'item', fields: ['t'] }, { wait: false });
  const page = await store.list({ index: 'byT', equals: { t: 'a' } });
  assert.deepEqual(page.items.map((i) => i.key), ['item:1']);
});

test('createLocalKv takes isAllowed', async () => {
  const { createLocalKv } = await import(join(PKG, 'index.mjs'));
  const { kvStore, backend } = createLocalKv({ isAllowed: (id) => id === 'linked' });
  backend.createStore({ id: 'site', format: 2 });
  backend.createStore({ id: 'linked', format: 2 });
  await assert.rejects(kvStore.get('site', 'k'), (err) => err.code === 'FORBIDDEN');
  assert.equal(await kvStore.get('linked', 'k'), null);
});
