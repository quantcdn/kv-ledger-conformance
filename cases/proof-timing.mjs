// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// proof (tag proof-timing): a ledger proof moves from pending to archived when the archive runs, an archived proof
// passes the four checks of spec 7 with admin.proofPublicKey, and the status archivedSeq reaches headSeq.
// The wait: control.advanceArchive when the adapter has it, else clock.advance in 30 s steps (a virtual clock is
// instant; a real clock waits) until the archive runs or the case deadline passes. One deadline per case (WAIT_MS
// from the start of the first wait), so a slow archive fails with a clear "not reached" before the case timeout.
// Off by default: it can take minutes.
import assert from 'node:assert/strict';
import { checkProof } from '../lib/proof-check.mjs';
import { COLLECTION, LEDGER, appendMany, assertProofStatus, declare } from './ledger-util.mjs';

const MINUTE_MS = 60000;
const CASE_TIMEOUT_MS = 20 * MINUTE_MS;
const WAIT_MS = CASE_TIMEOUT_MS - MINUTE_MS;
const STEP_MS = 30000;

function proofCase(name, run, needs = []) {
  return { name: `proof/${name}`, tags: ['proof-timing'], needs: ['proofTiming', ...needs], declares: ['ledger'],
    timeoutMs: CASE_TIMEOUT_MS, run };
}

async function advanceArchive(ctx) {
  if (ctx.caps.advanceArchive && typeof ctx.control?.advanceArchive === 'function') {
    await ctx.control.advanceArchive(ctx.storeId);
  }
}

/** The case deadline on ctx.clock: WAIT_MS from now. */
const deadlineOf = (ctx) => ctx.clock.now() + WAIT_MS;

/**
 * Calls probe until it returns a value other than undefined; between tries the clock moves by STEP_MS, never past
 * the deadline. Fails when the deadline has passed and the probe still returns undefined.
 */
async function waitFor(ctx, deadline, probe, what) {
  await advanceArchive(ctx);
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    const left = deadline - ctx.clock.now();
    if (left <= 0) assert.fail(`${what}: not reached after ${WAIT_MS / MINUTE_MS} minutes`);
    await ctx.clock.advance(Math.min(STEP_MS, left));
  }
}

async function archivedProof(ctx, key, deadline) {
  return waitFor(ctx, deadline, async () => {
    const proof = await ctx.kv.ledgerProof(LEDGER, key);
    assertProofStatus(proof);
    return proof.status === 'archived' ? proof : undefined;
  }, `the proof of ${key} archived`);
}

const linkOf = (o) => ({ key: o.key, id: o.id, shard: String(o.shard), seq: o.seq, at: o.at, hash: o.hash,
  prevHash: o.prevHash });

async function archived(ctx) {
  await declare(ctx);
  const [receipt] = await appendMany(ctx, 1);
  const proof = await archivedProof(ctx, receipt.key, deadlineOf(ctx));
  assert.equal(proof.hash, receipt.hash, 'proof hash = receipt hash');
  assert.deepEqual(linkOf(proof.entry), linkOf(receipt), 'proof entry fields = receipt');
  assert.equal(proof.entry.collection, COLLECTION);
  assert.equal(typeof proof.entry.value, 'string', 'the entry value is the stored string');
  assert.equal(typeof proof.period, 'string');
  assert.ok(proof.period.length > 0, 'period present');
  assert.equal(typeof proof.archiveKey, 'string');
  assert.ok(proof.archiveKey.length > 0, 'archiveKey present');
}

async function signed(ctx) {
  await declare(ctx, { chains: 2 });
  const receipts = await appendMany(ctx, 5);
  const publicKeyPem = await ctx.admin.proofPublicKey(ctx.storeId);
  const deadline = deadlineOf(ctx);
  for (const receipt of receipts) {
    const proof = await archivedProof(ctx, receipt.key, deadline);
    assert.equal(proof.digest.org, ctx.identity.org, 'digest org = identity org');
    assert.equal(proof.digest.store, ctx.identity.store, 'digest store = identity store');
    const result = checkProof(proof, publicKeyPem);
    assert.equal(result.ok, true, `seq ${receipt.seq} shard ${receipt.shard}: ${JSON.stringify(result.steps.filter((s) => !s.ok))}`);
  }
}

const APPENDED = 6;
const headTotal = (st) => st.shards.reduce((sum, s) => sum + s.headSeq, 0);

// At least one shard, every appended entry counted, and every shard archived up to its head.
const fullyArchived = (st) => st.shards.length > 0 && headTotal(st) === APPENDED
  && st.shards.every((s) => s.archivedSeq === s.headSeq);

async function statusArchived(ctx) {
  await declare(ctx, { chains: 2 });
  await appendMany(ctx, APPENDED);
  const st = await waitFor(ctx, deadlineOf(ctx), async () => {
    const status = await ctx.kv.ledgerStatus(LEDGER);
    assert.ok(Array.isArray(status.shards), 'status has shards');
    return fullyArchived(status) ? status : undefined;
  }, `archivedSeq = headSeq on every shard, ${APPENDED} entries`);
  if (typeof st.archivedSeq === 'number') assert.equal(st.archivedSeq, st.headSeq, 'archivedSeq reaches headSeq');
}

export const proofTimingCases = [
  proofCase('archived', archived),
  proofCase('signed', signed, ['signedProofs']),
  proofCase('status-archived', statusArchived),
];
