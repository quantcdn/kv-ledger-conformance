// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Pure byte-layout cases: no adapter. Each run(ctx) gets { ledgerBytes, vectors } and throws on a mismatch.
import assert from 'node:assert/strict';

const bytesCase = (name, run) => ({ name: `bytes/${name}`, tags: ['bytes'], needs: [], adapter: false, run });

const entryArgs = (instance, e) => ({ prevHash: e.prevHash, instance, seq: e.seq, id: e.id, at: e.at, stored: e.stored });

function definitionJcs({ ledgerBytes: lb, vectors: v }) {
  assert.equal(lb.canonicalJson(v.definition), v.definitionJcs);
}

function definitionHash({ ledgerBytes: lb, vectors: v }) {
  assert.equal(lb.sha256Hex(Buffer.from(v.definitionJcs, 'utf8')), v.definitionHash);
  assert.equal(lb.definitionHash(v.definition), v.definitionHash);
}

function genesis({ ledgerBytes: lb, vectors: v }) {
  assert.equal(lb.instanceName(v.org, v.store, v.collection, v.shard), v.instance);
  assert.equal(lb.genesisHash(v.instance, v.definitionHash), v.genesisPrevHash);
}

function entryHashes({ ledgerBytes: lb, vectors: v }) {
  for (const e of v.entries) assert.equal(lb.entryHash(entryArgs(v.instance, e)), e.hash, `seq ${e.seq}`);
}

function merkleRoots({ ledgerBytes: lb, vectors: v }) {
  const hashes = v.entries.map((e) => e.hash);
  for (const m of v.merkle) assert.equal(lb.merkleRoot(hashes.slice(0, m.n)), m.root, `n ${m.n}`);
}

function auditPaths({ ledgerBytes: lb, vectors: v }) {
  const hashes = v.entries.map((e) => e.hash);
  for (const p of v.proofs) {
    const label = `n ${p.n} index ${p.index}`;
    assert.deepEqual(lb.auditPath(p.index, hashes.slice(0, p.n)), p.auditPath, label);
    assert.equal(lb.rootFromAuditPath(p.leafHash, p.index, p.n, p.auditPath), p.root, label);
  }
}

function digestGenesis({ ledgerBytes: lb, vectors: v }) {
  assert.equal(lb.digestGenesisHash(v.org, v.store), v.digestGenesisPrevHash);
}

function sourceChain({ ledgerBytes: lb, vectors: v }) {
  const c = v.sourceChain;
  assert.equal(lb.genesisHash(c.instance, v.definitionHash), c.genesisPrevHash);
  for (const e of c.entries) assert.equal(lb.entryHash(entryArgs(c.instance, e)), e.hash, `seq ${e.seq}`);
  assert.equal(lb.merkleRoot(c.entries.map((e) => e.hash)), c.merkleRoot);
}

function forgedSource({ ledgerBytes: lb, vectors: v }) {
  const c = v.sourceChain;
  const e = c.entries[2];
  const forged = e.stored.replace('"type":"edge"', '"type":"dashboard"');
  assert.notEqual(forged, e.stored, 'the vector must hold the marker text');
  const args = { ...entryArgs(c.instance, e), stored: forged };
  assert.notEqual(lb.entryHash(args), e.hash);
}

export const bytesCases = [
  bytesCase('definition/jcs', definitionJcs),
  bytesCase('definition/hash', definitionHash),
  bytesCase('genesis', genesis),
  bytesCase('entry-hash', entryHashes),
  bytesCase('merkle-root', merkleRoots),
  bytesCase('audit-path', auditPaths),
  bytesCase('digest-genesis', digestGenesis),
  bytesCase('source-chain', sourceChain),
  bytesCase('source-chain/forged-source', forgedSource),
];
