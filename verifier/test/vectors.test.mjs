// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// An independent implementation must reproduce every published vector.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as lb from '../../lib/ledger-bytes.mjs';
import { canonicalJson } from '../lib/jcs.mjs';
import { entryHash, genesisHash, sha256Hex, digestGenesisHash } from '../lib/hash.mjs';
import { auditPath, merkleRoot, rootFromAuditPath } from '../lib/merkle.mjs';

const v = JSON.parse(readFileSync(new URL('../../vectors/ledger-vectors.json', import.meta.url), 'utf8'));
test('vectors', () => {
  assert.equal(canonicalJson(v.definition), v.definitionJcs);
  assert.equal(sha256Hex(v.definitionJcs), v.definitionHash);
  assert.equal(genesisHash(v.instance, v.definitionHash), v.genesisPrevHash);
  for (const e of v.entries) assert.equal(entryHash({ prevHash: e.prevHash, instance: v.instance, seq: e.seq, id: e.id, at: e.at, stored: e.stored }), e.hash);
  const hs = v.entries.map(e => e.hash);
  for (const m of v.merkle) assert.equal(merkleRoot(hs.slice(0, m.n)), m.root);
  for (const p of v.proofs) { assert.deepEqual(auditPath(p.index, hs.slice(0, p.n)), p.auditPath); assert.equal(rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath), p.root); }
  assert.equal(digestGenesisHash(v.org, v.store), v.digestGenesisPrevHash);
});
test('the suite and the verifier give the same results on every vector', () => {
  assert.equal(lb.canonicalJson(v.definition), canonicalJson(v.definition));
  assert.equal(lb.definitionHash(v.definition), sha256Hex(canonicalJson(v.definition)));
  assert.equal(lb.genesisHash(v.instance, v.definitionHash), genesisHash(v.instance, v.definitionHash));
  assert.equal(lb.digestGenesisHash(v.org, v.store), digestGenesisHash(v.org, v.store));
  for (const e of [...v.entries.map((x) => ({ ...x, instance: v.instance })), ...v.sourceChain.entries.map((x) => ({ ...x, instance: v.sourceChain.instance }))]) {
    assert.equal(lb.entryHash(e), entryHash(e));
  }
  const hs = v.entries.map((e) => e.hash);
  for (const m of v.merkle) assert.equal(lb.merkleRoot(hs.slice(0, m.n)), merkleRoot(hs.slice(0, m.n)));
  for (const p of v.proofs) {
    assert.deepEqual(lb.auditPath(p.index, hs.slice(0, p.n)), auditPath(p.index, hs.slice(0, p.n)));
    assert.equal(lb.rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath), rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath));
  }
});
test('audit path checks refuse bad indexes and malformed hashes', () => {
  const p = v.proofs[0];
  assert.equal(rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath), p.root);
  for (const index of [p.n, p.n + 2, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) assert.equal(rootFromAuditPath(p.leafHash, index, p.n, p.auditPath), undefined, `index ${index}`);
  assert.equal(rootFromAuditPath(p.leafHash, 0, 0, []), undefined);
  assert.equal(rootFromAuditPath(p.leafHash, 0, p.n, ['zz', ...p.auditPath.slice(1)]), undefined);
  assert.equal(rootFromAuditPath(p.leafHash.toUpperCase(), 0, p.n, p.auditPath), undefined);
});
test('provenance vectors: an independent implementation reproduces the source chain, and a changed source breaks it', () => {
  const c = v.sourceChain;
  assert.equal(genesisHash(c.instance, v.definitionHash), c.genesisPrevHash);
  for (const e of c.entries) assert.equal(entryHash({ prevHash: e.prevHash, instance: c.instance, seq: e.seq, id: e.id, at: e.at, stored: e.stored }), e.hash);
  assert.equal(merkleRoot(c.entries.map(e => e.hash)), c.merkleRoot);
  const e = c.entries[2];
  const forged = e.stored.replace('"type":"edge"', '"type":"dashboard"');
  assert.notEqual(entryHash({ prevHash: e.prevHash, instance: c.instance, seq: e.seq, id: e.id, at: e.at, stored: forged }), e.hash);
});
