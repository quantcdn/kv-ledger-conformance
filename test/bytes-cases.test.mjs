// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as ledgerBytes from '../lib/ledger-bytes.mjs';
import { bytesCases } from '../cases/bytes.mjs';

const vectors = JSON.parse(readFileSync(new URL('../vectors/ledger-vectors.json', import.meta.url), 'utf8'));

test('bytes cases follow the case format', () => {
  assert.ok(bytesCases.length >= 7);
  const names = new Set();
  for (const c of bytesCases) {
    assert.ok(/^bytes\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(c.name), c.name);
    assert.ok(!names.has(c.name));
    names.add(c.name);
    assert.deepEqual(c.tags, ['bytes']);
    assert.deepEqual(c.needs, []);
    assert.equal(c.adapter, false);
    assert.equal(typeof c.run, 'function');
  }
});

test('every bytes case passes against the vectors', async () => {
  for (const c of bytesCases) await c.run({ ledgerBytes, vectors });
});

test('a bytes case fails when a vector is wrong', async () => {
  const bad = structuredClone(vectors);
  bad.entries[1].hash = '0'.repeat(64);
  bad.merkle[2].root = '0'.repeat(64);
  bad.definitionHash = '0'.repeat(64);
  let failed = 0;
  for (const c of bytesCases) {
    try { await c.run({ ledgerBytes, vectors: bad }); } catch (e) { if (e instanceof assert.AssertionError) failed++; else throw e; }
  }
  assert.ok(failed >= 3);
});
