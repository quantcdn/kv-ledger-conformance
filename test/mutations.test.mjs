// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Mutation checks (spec 11): small broken adapters, each one the reference adapter with one kvStore method changed,
// must make a named case fail. This shows that the cases assert something. Each mutation changes the global
// kvStore method; a handle forwards to it, so both shapes see the change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as reference from '../adapters/reference/index.mjs';
import { run } from '../lib/runner.mjs';
import { pagedQuery } from '../lib/paged-query.mjs';

const BAD_HASH = '0'.repeat(64);

function withoutOption(options, name) {
  if (options === null || typeof options !== 'object') return options;
  const { [name]: _dropped, ...rest } = options;
  return rest;
}

// Replaces kvStore[method] with wrap(original).
const wrapMethod = (method, wrap) => (kvStore) => {
  const original = kvStore[method];
  kvStore[method] = wrap(original, kvStore);
};

const MUTATIONS = [
  {
    what: 'get returns undefined for a missing key',
    caseName: 'core/kv/get-missing-null',
    reason: /get of a missing key is null/,
    mutate: wrapMethod('get', (get) => async (...args) => (await get(...args)) ?? undefined),
  },
  {
    what: 'the seq 1 receipt has a wrong prevHash',
    caseName: 'ledger/genesis',
    reason: /seq 1 prevHash is the genesis hash/,
    mutate: wrapMethod('append', (append) => async (...args) => {
      const receipt = await append(...args);
      return receipt.seq === 1 ? { ...receipt, prevHash: BAD_HASH } : receipt;
    }),
  },
  {
    what: 'errors have no retryable field',
    caseName: 'core/kv/getMany-bounds',
    reason: /retryable: expected a boolean/,
    mutate: wrapMethod('getMany', (getMany) => async (...args) => {
      try {
        return await getMany(...args);
      } catch (err) {
        delete err.retryable;
        throw err;
      }
    }),
  },
  {
    what: 'list ignores the cursor (every page is the first page)',
    caseName: 'core/list/cursor-walk',
    reason: /page cap .* reached/,
    mutate: wrapMethod('list', (list, kvStore) => (storeId, options) =>
      pagedQuery((opts) => list(storeId, withoutOption(opts, 'cursor')), options, kvStore.KVError)),
  },
  {
    what: 'an idempotent append replay appends again',
    caseName: 'ledger/idempotent-replay',
    reason: /replayed: true/,
    mutate: wrapMethod('append', (append) => (storeId, collection, value, options) =>
      append(storeId, collection, value, withoutOption(options, 'idempotencyKey'))),
  },
  {
    what: 'verifyChain ignores gaps',
    caseName: 'core/verify-chain/gap',
    reason: /a gap: ok is false/,
    mutate: wrapMethod('verifyChain', (verifyChain) => (entries) => {
      const report = verifyChain(entries);
      const problems = report.problems.filter((p) => p.problem !== 'gap');
      return { ...report, ok: problems.length === 0, problems };
    }),
  },
  {
    what: 'set ignores ifVersion',
    caseName: 'core/conditional/ifVersion-mismatch',
    reason: /expected a KVError, but the call succeeded/,
    mutate: wrapMethod('set', (set) => (storeId, key, value, options) =>
      set(storeId, key, value, withoutOption(options, 'ifVersion'))),
  },
  {
    what: 'getMany returns the values in reverse order',
    caseName: 'core/kv/getMany-order',
    reason: /getMany order: result 0 is the first key/,
    mutate: wrapMethod('getMany', (getMany) => async (...args) => [...(await getMany(...args))].reverse()),
  },
  {
    what: 'a pending proof carries a field other than status',
    caseName: 'ledger/proof-pending',
    reason: /pending proof has only status/,
    mutate: wrapMethod('ledgerProof', (ledgerProof) => async (...args) => {
      const proof = await ledgerProof(...args);
      return proof.status === 'pending' ? { ...proof, hash: BAD_HASH } : proof;
    }),
  },
];

const mutantOf = (mutate) => ({
  async createAdapter(options) {
    const adapter = await reference.createAdapter(options);
    mutate(adapter.kvStore);
    return adapter;
  },
});

async function resultsOf(adapter, caseName) {
  const report = await run({ adapter, include: [caseName] });
  return report.results.filter((r) => r.name === caseName);
}

const statusesOf = async (adapter, caseName) => (await resultsOf(adapter, caseName)).map((r) => r.status);

test('every mutation names a different case', () => {
  const names = MUTATIONS.map((m) => m.caseName);
  assert.equal(new Set(names).size, names.length);
  assert.ok(MUTATIONS.length >= 6);
});

test('every mutation names the reason it must fail with', () => {
  for (const m of MUTATIONS) assert.ok(m.reason instanceof RegExp, m.caseName);
});

for (const { what, caseName, reason, mutate } of MUTATIONS) {
  test(`mutation "${what}" makes ${caseName} fail`, async () => {
    const clean = await statusesOf(reference, caseName);
    assert.ok(clean.length > 0, `${caseName} runs on the reference adapter`);
    assert.ok(clean.every((s) => s === 'pass'), `${caseName} passes on the reference adapter: ${clean}`);
    const mutated = await resultsOf(mutantOf(mutate), caseName);
    assert.equal(mutated.length, clean.length);
    for (const r of mutated) {
      assert.equal(r.status, 'fail', `${caseName} fails on the mutant`);
      assert.match(r.reason, reason, `${caseName} fails for the intended reason`);
    }
  });
}

// Variants the contract allows: each must still pass its case, so the case does not assert more than the contract.
const TOLERATED = [
  {
    what: 'LIMIT_EXCEEDED from append carries a status other than 400',
    caseName: 'ledger/value-size',
    mutate: wrapMethod('append', (append) => async (...args) => {
      try {
        return await append(...args);
      } catch (err) {
        if (err.code === 'LIMIT_EXCEEDED') err.status = 413;
        throw err;
      }
    }),
  },
  {
    what: 'atomic().increment in an indexed collection is not refused (only increment() is sourced)',
    caseName: 'core/indexes/increment-indexed',
    mutate: wrapMethod('atomic', () => () => {
      const builder = { increment: () => builder, commit: async () => ({ ok: true }) };
      return builder;
    }),
  },
];

for (const { what, caseName, mutate } of TOLERATED) {
  test(`variant "${what}" still passes ${caseName}`, async () => {
    const statuses = await statusesOf(mutantOf(mutate), caseName);
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((s) => s === 'pass'), `${caseName} passes on the variant: ${statuses}`);
  });
}
