// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// buildKvStore(base, KVError): the edge kvStore surface of kvstore.d.ts over a small store-id-first base.
// The base has async methods get, set, delete, getEntry, getMany, getBy, count, increment, list, search, append,
// ledgerStatus, ledgerProof and atomic(storeId, ops, commitOptions); list and search return one page.
// The surface adds: list/search iteration, the atomic builder, open(storeId), verifyChain, and KVError (not
// enumerable). Argument checks stay in the base (lib/edge-checks.mjs, bound to the same KVError class).
import { LIMITS } from './limits.mjs';
import { isPlainObject } from './check-util.mjs';
import { callAsync, pagedQuery } from './paged-query.mjs';
import { verifyChainEntries } from './verify-chain.mjs';

export const BASE_METHODS = Object.freeze(['get', 'set', 'delete', 'getEntry', 'getMany', 'getBy', 'count',
  'increment', 'list', 'search', 'append', 'ledgerStatus', 'ledgerProof', 'atomic']);
const HANDLE_FORWARD = BASE_METHODS.filter((name) => name !== 'get' && name !== 'atomic');

function assertInputs(base, KVError) {
  if (typeof KVError !== 'function') throw new TypeError('buildKvStore needs a KVError class');
  const missing = BASE_METHODS.find((name) => typeof base?.[name] !== 'function');
  if (missing !== undefined) throw new TypeError(`buildKvStore: the base has no method ${missing}`);
}

// { op: 'check', key, version } | { op: 'set', key, value, options } | { op: 'delete', key, options }
// | { op: 'increment', key, amount }. commit() sends them once; a second commit is VALIDATION.
function createAtomicBuilder(base, storeId, KVError) {
  const ops = [];
  let committed = false;
  const builder = {};
  const add = (op) => {
    ops.push(op);
    return builder;
  };
  builder.check = (key, version) => add({ op: 'check', key, version });
  builder.set = (key, value, options) => add({ op: 'set', key, value, options });
  builder.delete = (key, options) => add({ op: 'delete', key, options });
  builder.increment = (key, amount) => add({ op: 'increment', key, amount });
  builder.commit = (options) => {
    if (committed) return Promise.reject(new KVError('VALIDATION', 'commit can be called once'));
    committed = true;
    return callAsync(base.atomic, base, [storeId, [...ops], options]);
  };
  return builder;
}

// handle.get options: undefined, a boolean, or { raw?: boolean }. Returns skipDecode, or null when invalid.
function skipDecodeOf(options) {
  if (options === undefined || typeof options === 'boolean') return options === true;
  if (!isPlainObject(options) || Object.keys(options).some((name) => name !== 'raw')) return null;
  if (options.raw === undefined) return false;
  return typeof options.raw === 'boolean' ? options.raw : null;
}

function openHandle(kvStore, storeId, KVError) {
  if (typeof storeId !== 'string') throw new KVError('VALIDATION', 'storeId must be a string');
  const handle = {
    storeId,
    get(key, options) {
      const skipDecode = skipDecodeOf(options);
      if (skipDecode === null) return Promise.reject(new KVError('VALIDATION', 'get options must be a boolean or { raw?: boolean }'));
      return kvStore.get(storeId, key, skipDecode);
    },
    atomic: () => kvStore.atomic(storeId),
    verifyChain: kvStore.verifyChain,
  };
  for (const name of HANDLE_FORWARD) handle[name] = (...args) => kvStore[name](storeId, ...args);
  return Object.freeze(handle);
}

export function makeVerifyChain(KVError) {
  return function verifyChain(entries) {
    if (!Array.isArray(entries)) throw new KVError('VALIDATION', 'verifyChain takes an array');
    if (entries.length > LIMITS.verifyChainMaxEntries) {
      throw new KVError('VALIDATION', 'verifyChain takes at most the verifyChain entry limit');
    }
    return verifyChainEntries(entries);
  };
}

export function buildKvStore(base, KVError) {
  assertInputs(base, KVError);
  const kvStore = {};
  for (const name of BASE_METHODS) kvStore[name] = (...args) => callAsync(base[name], base, args);
  kvStore.get = (storeId, key, skipDecode) => callAsync(base.get, base, [storeId, key, Boolean(skipDecode)]);
  for (const name of ['list', 'search']) {
    kvStore[name] = (storeId, options) => pagedQuery((opts) => base[name](storeId, opts), options, KVError);
  }
  kvStore.atomic = (storeId) => createAtomicBuilder(base, storeId, KVError);
  kvStore.open = (storeId) => openHandle(kvStore, storeId, KVError);
  kvStore.verifyChain = makeVerifyChain(KVError);
  Object.defineProperty(kvStore, 'KVError', { value: KVError, enumerable: false, writable: false, configurable: false });
  return kvStore;
}
