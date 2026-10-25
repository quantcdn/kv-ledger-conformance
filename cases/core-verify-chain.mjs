// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/verify-chain: kvStore.verifyChain is a local function over receipts or list items.
import assert from 'node:assert/strict';
import { coreCase, expectValidation } from './core-util.mjs';

const H = (n) => `hash-${n}`;
const receipt = (seq, { shard = '00', hash = H(seq), prevHash = seq === 1 ? 'genesis' : H(seq - 1) } = {}) => (
  { shard, seq, hash, prevHash });
const chain = (n, shard = '00') => Array.from({ length: n }, (_, i) => receipt(i + 1, { shard }));

// Handle shape: the handle's verifyChain (the same function as kvStore.verifyChain); global shape: kvStore's.
// The method is called on its object, never detached.
const verifyOf = (ctx) => (entries) => (ctx.shape === 'handle'
  ? ctx.kv.verifyChain(entries)
  : ctx.kvStore.verifyChain(entries));

const problemsOf = (report) => report.problems.map((p) => p.problem);

async function ok(ctx) {
  const report = verifyOf(ctx)(chain(4));
  assert.equal(report.ok, true);
  assert.equal(report.checked, 4);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.shards.map((s) => [s.shard, s.first, s.last, s.count]), [['00', 1, 4, 4]]);
}

async function gap(ctx) {
  const entries = chain(4).filter((e) => e.seq !== 3);
  const report = verifyOf(ctx)(entries);
  assert.equal(report.ok, false, 'a gap: ok is false');
  const found = report.problems.find((p) => p.problem === 'gap');
  assert.ok(found, `a gap, got ${problemsOf(report)}`);
  assert.equal(found.seq, 4);
}

async function fork(ctx) {
  const entries = [...chain(3), receipt(2, { hash: 'other-2' })];
  const report = verifyOf(ctx)(entries);
  assert.equal(report.ok, false);
  const found = report.problems.find((p) => p.problem === 'fork');
  assert.ok(found, `a fork, got ${problemsOf(report)}`);
  assert.equal(found.seq, 2);
}

async function brokenLink(ctx) {
  const entries = [receipt(1), receipt(2, { prevHash: 'not-the-hash' }), receipt(3)];
  const report = verifyOf(ctx)(entries);
  assert.equal(report.ok, false);
  const found = report.problems.find((p) => p.problem === 'broken-link');
  assert.ok(found, `a broken link, got ${problemsOf(report)}`);
  assert.equal(found.seq, 2);
}

async function missingFields(ctx) {
  const { hash, ...noHash } = receipt(2);
  assert.ok(hash);
  const report = verifyOf(ctx)([receipt(1), noHash, { seq: 0, shard: '00', hash: 'h', prevHash: 'p' }]);
  assert.equal(report.ok, false);
  const indexes = report.problems.filter((p) => p.problem === 'missing-fields').map((p) => p.index);
  assert.deepEqual(indexes, [1, 2]);
}

async function duplicates(ctx) {
  const report = verifyOf(ctx)([...chain(3), receipt(2), receipt(3)]);
  assert.equal(report.ok, true, `no problem, got ${problemsOf(report)}`);
  assert.equal(report.checked, 3);
}

async function shardsSorted(ctx) {
  const report = verifyOf(ctx)([...chain(2, '03'), ...chain(3, '00'), ...chain(1, '01')]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.shards.map((s) => [String(s.shard), s.count]), [['00', 3], ['01', 1], ['03', 2]]);
  assert.equal(report.checked, 6);
}

async function listItemForm(ctx) {
  const items = chain(3).map((link, i) => ({ key: `audit:${i}`, value: { i }, ledger: { ...link, name: 'audit' } }));
  const report = verifyOf(ctx)(items);
  assert.equal(report.ok, true);
  assert.equal(report.checked, 3);
}

async function notArray(ctx) {
  await expectValidation(ctx, [() => verifyOf(ctx)('x'), () => verifyOf(ctx)({ length: 1 })],
    'not an array');
}

async function tooMany(ctx) {
  const entries = Array.from({ length: ctx.limits.verifyChainMaxEntries + 1 }, () => receipt(1));
  await expectValidation(ctx, [() => verifyOf(ctx)(entries)], 'too many');
  assert.equal(verifyOf(ctx)(entries.slice(1)).ok, true, 'the limit itself is accepted');
}

export const coreVerifyChainCases = [
  coreCase('verify-chain/ok', ok),
  coreCase('verify-chain/gap', gap),
  coreCase('verify-chain/fork', fork),
  coreCase('verify-chain/broken-link', brokenLink),
  coreCase('verify-chain/missing-fields', missingFields),
  coreCase('verify-chain/duplicates', duplicates),
  coreCase('verify-chain/shards-sorted', shardsSorted),
  coreCase('verify-chain/list-item-form', listItemForm),
  coreCase('verify-chain/not-array', notArray),
  coreCase('verify-chain/too-many', tooMany),
];
