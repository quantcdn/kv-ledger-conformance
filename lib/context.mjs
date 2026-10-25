// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The per-case context (spec 4.2).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LIMITS } from './limits.mjs';
import { expectKVError } from './expect.mjs';
import * as ledgerBytes from './ledger-bytes.mjs';

let vectorsCache = null;
export function loadVectors() {
  if (!vectorsCache) {
    vectorsCache = JSON.parse(readFileSync(new URL('../vectors/ledger-vectors.json', import.meta.url), 'utf8'));
  }
  return vectorsCache;
}

const NOT_BOUND = new Set(['KVError', 'open']);

// Global shape: every method call gets the store id first; get(key, { raw: true }) becomes get(id, key, true).
export function bindGlobal(kvStore, storeId) {
  const special = {
    get: (key, opts) => (opts && opts.raw === true ? kvStore.get(storeId, key, true) : kvStore.get(storeId, key, opts)),
  };
  return new Proxy({}, {
    get(_, prop) {
      if (special[prop]) return special[prop];
      if (typeof prop !== 'string' || NOT_BOUND.has(prop) || typeof kvStore[prop] !== 'function') return undefined;
      return (...args) => kvStore[prop](storeId, ...args);
    },
  });
}

export function createUniqueKey() {
  let counter = 0;
  return (prefix = 'k') => `${prefix}-${(++counter).toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function pureContext() {
  return { ledgerBytes, vectors: loadVectors(), limits: LIMITS };
}

export function buildContext({ adapter, clock, store, shape, uniqueKey }) {
  const { kvStore } = adapter;
  return {
    kvStore,
    kv: shape === 'handle' ? kvStore.open(store.storeId) : bindGlobal(kvStore, store.storeId),
    storeId: store.storeId,
    identity: store.identity,
    admin: adapter.admin,
    control: adapter.control,
    clock,
    caps: adapter.capabilities || {},
    shape,
    limits: LIMITS,
    ledgerBytes,
    vectors: loadVectors(),
    uniqueKey,
    expectKVError: (target, expected) => expectKVError(kvStore, target, expected),
  };
}
