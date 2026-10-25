// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// ledger/read: time windows, merge order, verifyChain over a list, status, proofs and a dropped ledger.
import assert from 'node:assert/strict';
import { allPages, expectValidation } from './core-util.mjs';
import { COLLECTION, LEDGER, appendMany, assertProofStatus, byShard, compareMerge, declare, ledgerCase } from './ledger-util.mjs';

const itemsOf = (pages) => pages.flatMap((page) => page.items);
const listKeys = async (ctx, options) => itemsOf(await allPages(ctx.kv.list({ collection: COLLECTION, ...options })))
  .map((item) => item.key);

// The same instant as ISO 8601 with a +10:00 offset.
function withOffset(ms) {
  const local = new Date(ms + 10 * 3600000).toISOString();
  return `${local.slice(0, -1)}+10:00`;
}

// Three entries, each one second after the one before.
async function spaced(ctx) {
  const receipts = [];
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await ctx.clock.advance(1000);
    receipts.push(await ctx.kv.append(COLLECTION, { i }));
  }
  return receipts;
}

async function window(ctx) {
  await declare(ctx);
  const [r0, r1, r2] = await spaced(ctx);
  assert.ok(r0.at < r1.at && r1.at < r2.at, 'entries one second apart');
  assert.deepEqual(await listKeys(ctx, { since: r1.at, until: r2.at }), [r1.key], 'since inclusive, until exclusive');
  assert.deepEqual(await listKeys(ctx, { since: r1.at }), [r1.key, r2.key]);
  assert.deepEqual(await listKeys(ctx, { until: r1.at }), [r0.key]);
  assert.deepEqual(await listKeys(ctx, { since: new Date(r1.at).toISOString() }), [r1.key, r2.key], 'ISO with Z');
  assert.deepEqual(await listKeys(ctx, { since: withOffset(r1.at), until: withOffset(r2.at) }), [r1.key],
    'ISO with an offset');
  const zoneless = new Date(r1.at).toISOString().slice(0, -1);
  await expectValidation(ctx, [
    () => ctx.kv.list({ collection: COLLECTION, since: zoneless }),
    () => ctx.kv.list({ collection: COLLECTION, since: r1.at, until: r1.at }),
    () => ctx.kv.list({ collection: COLLECTION, since: r2.at, until: r1.at }),
    () => ctx.kv.list({ collection: COLLECTION, since: r1.at, where: { i: 1 } }),
    () => ctx.kv.list({ collection: COLLECTION, since: r1.at, type: 'encrypted' }),
  ], 'window options');
}

async function mergeOrder(ctx) {
  await declare(ctx, { chains: 4 });
  const receipts = [];
  for (let i = 0; i < 4; i += 1) {
    receipts.push(...await appendMany(ctx, 4));
    await ctx.clock.advance(1);
  }
  const expected = [...receipts].sort(compareMerge).map((r) => r.key);
  assert.deepEqual(await listKeys(ctx, { limit: 5 }), expected, 'at, then shard, then id');
  assert.deepEqual(await listKeys(ctx, { limit: 5, reverse: true }), [...expected].reverse(), 'the exact reverse');
}

async function listVerifyChain(ctx) {
  await declare(ctx, { chains: 2 });
  await appendMany(ctx, 7);
  const items = itemsOf(await allPages(ctx.kv.list({ collection: COLLECTION, limit: 3, includeValues: true })));
  assert.equal(items.length, 7);
  const report = ctx.kvStore.verifyChain(items);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.checked, 7);
}

async function status(ctx) {
  await declare(ctx, { chains: 2 });
  const receipts = await appendMany(ctx, 5);
  const st = await ctx.kv.ledgerStatus(LEDGER);
  assert.equal(st.name, LEDGER);
  assert.equal(st.state, 'ACTIVE');
  assert.equal(st.collection, COLLECTION);
  assert.equal(st.chains, 2);
  assert.equal(st.headSeq, 5, 'headSeq sums the shards');
  assert.equal(typeof st.hasMoreShards, 'boolean');
  assert.ok(Array.isArray(st.shards));
  for (const [shard, group] of byShard(receipts)) {
    const row = st.shards.find((s) => String(s.shard) === shard);
    assert.ok(row, `shard ${shard} in status`);
    assert.equal(row.headSeq, group.length, `shard ${shard} headSeq`);
  }
}

async function statusNotFound(ctx) {
  await ctx.expectKVError(() => ctx.kv.ledgerStatus('nope'), { code: 'LEDGER_NOT_FOUND', retryable: false });
}

async function proofPending(ctx) {
  await declare(ctx);
  const r = await ctx.kv.append(COLLECTION, { a: 1 });
  assertProofStatus(await ctx.kv.ledgerProof(LEDGER, r.key));
}

async function dropped(ctx) {
  await declare(ctx);
  await ctx.admin.dropLedger(ctx.storeId, LEDGER);
  await ctx.expectKVError(() => ctx.kv.append(COLLECTION, { a: 1 }),
    { code: 'LEDGER_DROPPED', status: 409, retryable: false, details: { ledger: LEDGER } });
  assert.equal((await ctx.kv.ledgerStatus(LEDGER)).state, 'DROPPED');
}

const CLOCK = { needs: ['virtualClock'] };

export const ledgerReadCases = [
  ledgerCase('window', window, CLOCK),
  ledgerCase('merge-order', mergeOrder),
  ledgerCase('list-verifyChain', listVerifyChain),
  ledgerCase('status', status),
  ledgerCase('status-not-found', statusNotFound),
  ledgerCase('proof-pending', proofPending),
  ledgerCase('dropped', dropped),
];
