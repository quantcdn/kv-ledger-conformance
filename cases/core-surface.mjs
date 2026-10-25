// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/surface: the kvStore object, open(), the handle and the store allow-list.
import assert from 'node:assert/strict';
import { coreCase, expectValidation, viewFor } from './core-util.mjs';

const METHODS = ['get', 'set', 'delete', 'getEntry', 'getMany', 'getBy', 'count', 'increment', 'list', 'search',
  'append', 'ledgerStatus', 'ledgerProof', 'atomic', 'open', 'verifyChain'];

async function methods({ kvStore }) {
  for (const name of METHODS) assert.equal(typeof kvStore[name], 'function', `kvStore.${name}`);
  assert.equal(typeof kvStore.KVError, 'function', 'kvStore.KVError');
  assert.ok(!Object.keys(kvStore).includes('KVError'), 'KVError is not enumerable');
}

async function openNonString({ kvStore }) {
  let thrown;
  try {
    kvStore.open(123);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== undefined, 'open(123) throws synchronously');
  assert.ok(thrown instanceof kvStore.KVError, 'instanceof KVError');
  assert.equal(thrown.code, 'VALIDATION');
}

async function handleFields({ kv, storeId }) {
  assert.equal(kv.storeId, storeId);
  assert.ok(Object.isFrozen(kv), 'the handle is frozen');
}

const FORBIDDEN = { code: 'FORBIDDEN', status: 403, retryable: false };

async function forbiddenStore(ctx) {
  const other = viewFor(ctx, ctx.uniqueKey('not-linked'));
  await ctx.expectKVError(() => other.get('k'), FORBIDDEN);
  await ctx.expectKVError(() => other.list(), FORBIDDEN);
}

async function invalidStoreId(ctx) {
  // LIMITS.storeId allows 1-255 characters; keyMaxBytes characters is well over that.
  const ids = ['a/b', 'x'.repeat(ctx.limits.keyMaxBytes)];
  await expectValidation(ctx, ids.map((id) => () => viewFor(ctx, id).get('k')), 'store id');
}

export const coreSurfaceCases = [
  coreCase('surface/methods', methods),
  coreCase('surface/open-non-string', openNonString),
  coreCase('surface/handle-fields', handleFields, { shapes: ['handle'] }),
  coreCase('surface/forbidden-store', forbiddenStore),
  coreCase('surface/invalid-store-id', invalidStoreId),
];
