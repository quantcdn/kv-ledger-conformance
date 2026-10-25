// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The simulated archive of the local backend (spec 9.1): per shard per 5-minute period, on archiveNow or lazily
// once the clock passes the period end + 60 s; one signed digest per store per period, chained; proofs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalBackend } from '../adapters/reference/backend/index.mjs';
import * as reference from '../adapters/reference/index.mjs';
import { createVirtualClock } from '../lib/clock.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS } from '../lib/limits.mjs';
import { canonicalJson, digestGenesisHash, sha256Hex } from '../lib/ledger-bytes.mjs';
import { checkProof } from '../lib/proof-check.mjs';
import { verifyProof } from '../verifier/lib/proof.mjs';

const KVError = createKVErrorClass();
const ORG = 'test-org';
const DEF = { name: 'audit', collection: 'audit', chains: 1, retentionDays: 1 };
const DAY_MS = 86400000;
const ARCHIVE_KEY = /^ledgers\/test-org\/s1\/audit\/YXVkaXQ\/\d{2}\/\d{8}T\d{4}Z-\d{12}-\d{12}\.jsonl\.gz$/;

function make(def = DEF, options = {}) {
  const clock = createVirtualClock();
  const backend = createLocalBackend({ clock, KVError, org: ORG, ...options });
  backend.createStore({ id: 's1', format: 2 });
  backend.declareLedger('s1', def, { wait: true });
  return { backend, clock };
}

const appendN = (backend, n, collection = 'audit') => Array.from({ length: n }, (_, i) => backend.append('s1', collection, { i }, {}));
const proofOf = (backend, r) => backend.ledgerProof('s1', 'audit', r.key);

function assertVerifies(backend, proof) {
  const pem = backend.publicKey();
  const mine = checkProof(proof, pem);
  assert.equal(mine.ok, true, JSON.stringify(mine.steps));
  const theirs = verifyProof({ proof, keys: pem });
  assert.deepEqual(theirs.steps.filter((s) => !s.ok).map((s) => s.step), [], JSON.stringify(theirs.steps));
}

test('before the archive a proof is pending; archiveNow makes it archived and signed', () => {
  const { backend } = make();
  const [r] = appendN(backend, 1);
  assert.deepEqual(proofOf(backend, r), { status: 'pending' });
  assert.equal(backend.ledgerStatus('s1', 'audit').archivedSeq, 0);
  backend.archiveNow('s1');
  const proof = proofOf(backend, r);
  assert.equal(proof.status, 'archived');
  assert.equal(proof.hash, r.hash);
  assert.deepEqual({ key: proof.entry.key, seq: proof.entry.seq, id: proof.entry.id, shard: proof.entry.shard,
    at: proof.entry.at, prevHash: proof.entry.prevHash, hash: proof.entry.hash },
  { key: r.key, seq: r.seq, id: r.id, shard: r.shard, at: r.at, prevHash: r.prevHash, hash: r.hash });
  assert.deepEqual(JSON.parse(proof.entry.value).value, { i: 0 });
  assert.deepEqual(proof.source, r.source);
  assert.match(proof.archiveKey, ARCHIVE_KEY);
  assert.match(proof.period, /^\d{8}T\d{4}Z$/);
  assert.equal(proof.digestKey, `digests/test-org/s1/${proof.period}.json`);
  assert.equal(proof.digestSignedAt, proof.digest.signedAt);
  assert.equal(typeof proof.keyId, 'string');
  assert.equal(proof.digest.prevDigestHash, digestGenesisHash(ORG, 's1'));
  assertVerifies(backend, proof);
});

test('every entry over 4 shards gets a proof that both checkers accept; status follows', () => {
  const { backend } = make({ ...DEF, chains: 4 });
  const receipts = appendN(backend, 13);
  backend.archiveNow('s1');
  const shards = new Set(receipts.map((r) => r.shard));
  for (const r of receipts) {
    const proof = proofOf(backend, r);
    assert.equal(proof.treeSize, receipts.filter((x) => x.shard === r.shard).length);
    assert.equal(proof.leafIndex, r.seq - 1);
    assert.equal(proof.digest.ledgers[0].instances.length, shards.size);
    assertVerifies(backend, proof);
  }
  const st = backend.ledgerStatus('s1', 'audit');
  assert.equal(st.archivedSeq, st.headSeq);
  assert.equal(st.lag, 0);
  for (const s of st.shards) assert.equal(s.archivedSeq, s.headSeq);
});

test('the archive runs lazily once the clock passes the period end plus 60 s', async () => {
  const { backend, clock } = make();
  const [r] = appendN(backend, 1);
  const periodEnd = Math.floor(r.at / LIMITS.archivePeriodMs) * LIMITS.archivePeriodMs + LIMITS.archivePeriodMs;
  await clock.advance(periodEnd + LIMITS.archiveDelayMs - 1 - clock.now());
  assert.equal(proofOf(backend, r).status, 'pending');
  assert.ok(backend.ledgerStatus('s1', 'audit').lag > 0);
  await clock.advance(1);
  assert.equal(backend.ledgerStatus('s1', 'audit').archivedSeq, 1);
  assertVerifies(backend, proofOf(backend, r));
});

test('digests chain; a second run in one period writes a supplementary digest', async () => {
  const { backend, clock } = make();
  const [a] = appendN(backend, 1);
  backend.archiveNow('s1');
  const [b] = appendN(backend, 1);
  backend.archiveNow('s1');
  const pa = proofOf(backend, a);
  const pb = proofOf(backend, b);
  assert.equal(pb.digestKey, `digests/test-org/s1/${pa.period}_000001.json`);
  assert.equal(pb.digest.prevDigestHash, sha256Hex(Buffer.from(canonicalJson(pa.digest), 'utf8')));
  assert.equal(pb.leafIndex, 0);
  assert.equal(pb.treeSize, 1);
  assertVerifies(backend, pb);
  await clock.advance(LIMITS.archivePeriodMs * 3);
  const [c] = appendN(backend, 1);
  backend.archiveNow('s1');
  const pc = proofOf(backend, c);
  assert.notEqual(pc.period, pa.period);
  assert.equal(pc.digest.prevDigestHash, sha256Hex(Buffer.from(canonicalJson(pb.digest), 'utf8')));
  assertVerifies(backend, pc);
});

test('a period with no new entries writes no digest; archiveNow on an empty store does nothing', () => {
  const { backend } = make();
  backend.archiveNow('s1');
  const [r] = appendN(backend, 1);
  backend.archiveNow('s1');
  backend.archiveNow('s1');
  assert.equal(proofOf(backend, r).digest.prevDigestHash, digestGenesisHash(ORG, 's1'));
});

test('drop: LEDGER_RETAINED while unarchived, then with retainUntil until retention ends', async () => {
  const { backend, clock } = make();
  appendN(backend, 2);
  assert.throws(() => backend.dropLedger('s1', 'audit'), (e) => e.code === 'LEDGER_RETAINED' && e.reason === 'unarchived');
  backend.archiveNow('s1');
  assert.throws(() => backend.dropLedger('s1', 'audit'),
    (e) => e.code === 'LEDGER_RETAINED' && typeof e.retainUntil === 'string');
  assert.equal(typeof backend.ledgerStatus('s1', 'audit').retainUntil, 'string');
  await clock.advance(DEF.retentionDays * DAY_MS + 1);
  assert.equal(backend.dropLedger('s1', 'audit'), true);
  assert.equal(backend.ledgerStatus('s1', 'audit').state, 'DROPPED');
});

test('snapshot and restore keep the archive and the signing key', () => {
  const { backend } = make();
  const [r] = appendN(backend, 3);
  backend.archiveNow('s1');
  const copy = createLocalBackend({ clock: createVirtualClock(), KVError, org: ORG });
  copy.restore(JSON.parse(JSON.stringify(backend.snapshot())));
  assert.equal(copy.publicKey(), backend.publicKey());
  assertVerifies(copy, copy.ledgerProof('s1', 'audit', r.key));
});

test('the reference adapter exposes the archive: capabilities, proofPublicKey, advanceArchive', async () => {
  const adapter = await reference.createAdapter();
  assert.equal(adapter.capabilities.proofTiming, true);
  assert.equal(adapter.capabilities.signedProofs, true);
  assert.equal(adapter.capabilities.advanceArchive, true);
  assert.equal(adapter.capabilities.subjectV1, false);
  const { storeId } = await adapter.admin.createStore({ format: 2 });
  await adapter.admin.declareLedger(storeId, DEF);
  const r = await adapter.kvStore.append(storeId, 'audit', { a: 1 });
  await adapter.control.advanceArchive(storeId);
  const proof = await adapter.kvStore.ledgerProof(storeId, 'audit', r.key);
  const pem = await adapter.admin.proofPublicKey(storeId);
  assert.match(pem, /BEGIN PUBLIC KEY/);
  assert.equal(checkProof(proof, pem).ok, true);
  await adapter.admin.dispose();
});
