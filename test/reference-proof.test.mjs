// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The reference adapter passes the proof-timing cases, with advanceArchive and, without it, by the clock alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../lib/runner.mjs';
import { cases } from '../cases/index.mjs';
import * as reference from '../adapters/reference/index.mjs';

const failing = (report) => report.results
  .filter((r) => r.status !== 'pass')
  .map((r) => `${r.name} [${r.shape}] ${r.status}: ${r.reason}`);

const proofCases = cases.filter((c) => c.tags.includes('proof-timing'));

test('the proof-timing cases are the proof group', () => {
  assert.deepEqual(proofCases.map((c) => c.name), ['proof/archived', 'proof/signed', 'proof/status-archived']);
  for (const c of proofCases) {
    assert.deepEqual(c.tags, ['proof-timing']);
    assert.ok(c.needs.includes('proofTiming'), c.name);
    assert.equal(c.timeoutMs, 20 * 60 * 1000);
  }
  assert.ok(proofCases.find((c) => c.name === 'proof/signed').needs.includes('signedProofs'));
});

test('the proof-timing cases are off by default', async () => {
  const report = await run({ adapter: reference, include: ['proof/'] });
  assert.equal(report.results.length, proofCases.length);
  assert.ok(report.results.every((r) => r.status === 'skip' && r.reason === 'tag proof-timing not selected'));
});

test('reference adapter passes the proof-timing cases', { timeout: 120000 }, async () => {
  const report = await run({ adapter: reference, tags: ['proof-timing'], include: ['proof/'] });
  assert.deepEqual(failing(report), []);
  assert.equal(report.summary.pass, proofCases.length * 2);
});

// The reference adapter without the advanceArchive hook: the cases wait by clock.advance, and the backend archives
// lazily at the next status or proof call.
const noHook = {
  async createAdapter(options) {
    const adapter = await reference.createAdapter(options);
    const { advanceArchive, ...control } = adapter.control;
    assert.equal(typeof advanceArchive, 'function');
    return { ...adapter, control, capabilities: { ...adapter.capabilities, advanceArchive: false } };
  },
};

test('reference adapter passes the proof-timing cases by the clock alone', { timeout: 120000 }, async () => {
  const report = await run({ adapter: noHook, tags: ['proof-timing'], include: ['proof/'] });
  assert.deepEqual(failing(report), []);
  assert.equal(report.summary.pass, proofCases.length * 2);
});

// A kvStore copy with some methods replaced; KVError stays non-enumerable.
function withMethods(kvStore, methods) {
  const copy = { ...kvStore, ...methods };
  Object.defineProperty(copy, 'KVError', { value: kvStore.KVError, enumerable: false });
  return copy;
}

const GAP_MS = 10 * 60 * 1000;

// No advanceArchive hook. Each proof stays pending until GAP_MS after its first ledgerProof call: with one wait
// budget per receipt the signed case would pass after 5 * GAP_MS; with one deadline per case it must fail.
const slowArchive = {
  async createAdapter(options) {
    const adapter = await noHook.createAdapter(options);
    const gates = new Map();
    const { kvStore, clock } = adapter;
    const ledgerProof = async (storeId, name, key) => {
      if (!gates.has(key)) gates.set(key, clock.now() + GAP_MS);
      if (clock.now() < gates.get(key)) return { status: 'pending' };
      return kvStore.ledgerProof(storeId, name, key);
    };
    return { ...adapter, kvStore: withMethods(kvStore, { ledgerProof }) };
  },
};

test('proof/signed has one deadline per case: a slow archive is "not reached"', { timeout: 120000 }, async () => {
  const report = await run({ adapter: slowArchive, tags: ['proof-timing'], include: ['proof/signed'], shapes: ['global'] });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, 'fail');
  assert.match(report.results[0].reason, /not reached/);
});

// ledgerStatus answers with no shards for the first calls: the probe must keep waiting, not accept an empty list.
const lateShards = {
  async createAdapter(options) {
    const adapter = await noHook.createAdapter(options);
    const { kvStore } = adapter;
    let calls = 0;
    const ledgerStatus = async (storeId, name) => {
      const status = await kvStore.ledgerStatus(storeId, name);
      calls += 1;
      return calls <= 2 ? { ...status, shards: [] } : status;
    };
    return { ...adapter, kvStore: withMethods(kvStore, { ledgerStatus }) };
  },
};

test('proof/status-archived waits while the status has no shards', { timeout: 120000 }, async () => {
  const report = await run({ adapter: lateShards, tags: ['proof-timing'], include: ['proof/status-archived'], shapes: ['global'] });
  assert.deepEqual(failing(report), []);
});
