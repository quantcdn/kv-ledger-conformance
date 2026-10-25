// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as lb from '../lib/ledger-bytes.mjs';

const v = JSON.parse(readFileSync(new URL('../vectors/ledger-vectors.json', import.meta.url), 'utf8'));

test('definition JCS, hash, genesis and instance', () => {
  assert.equal(lb.canonicalJson(v.definition), v.definitionJcs);
  assert.equal(lb.definitionHash(v.definition), v.definitionHash);
  assert.equal(lb.instanceName(v.org, v.store, v.collection, v.shard), v.instance);
  assert.equal(lb.genesisHash(v.instance, v.definitionHash), v.genesisPrevHash);
  assert.equal(lb.digestGenesisHash(v.org, v.store), v.digestGenesisPrevHash);
});

test('entry hashes, Merkle roots, audit paths', () => {
  for (const e of v.entries) assert.equal(lb.entryHash({ ...e, instance: v.instance }), e.hash);
  const hs = v.entries.map((e) => e.hash);
  for (const m of v.merkle) assert.equal(lb.merkleRoot(hs.slice(0, m.n)), m.root);
  for (const p of v.proofs) {
    assert.deepEqual(lb.auditPath(p.index, hs.slice(0, p.n)), p.auditPath);
    assert.equal(lb.rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath), p.root);
  }
});

test('source chain, and a forged source breaks the hash', () => {
  const c = v.sourceChain;
  assert.equal(lb.genesisHash(c.instance, v.definitionHash), c.genesisPrevHash);
  for (const e of c.entries) assert.equal(lb.entryHash({ ...e, instance: c.instance }), e.hash);
  assert.equal(lb.merkleRoot(c.entries.map((e) => e.hash)), c.merkleRoot);
  const e = c.entries[2];
  const forged = e.stored.replace('"type":"edge"', '"type":"dashboard"');
  assert.notEqual(forged, e.stored);
  assert.notEqual(lb.entryHash({ ...e, instance: c.instance, stored: forged }), e.hash);
});

test('audit path checks refuse bad input', () => {
  const p = v.proofs[0];
  for (const index of [p.n, -1, 1.5]) assert.equal(lb.rootFromAuditPath(p.leafHash, index, p.n, p.auditPath), undefined);
  assert.equal(lb.rootFromAuditPath(p.leafHash, 0, p.n, ['zz', ...p.auditPath.slice(1)]), undefined);
  assert.throws(() => lb.merkleRoot([]), RangeError);
  assert.throws(() => lb.auditPath(9, ['a']), RangeError);
});
