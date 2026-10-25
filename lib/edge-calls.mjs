// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The edge layer shared by the reference and HTTP adapters: the base that buildKvStore wraps. Each method runs the
// edge checks (lib/edge-checks.mjs) and the store allow-list, then calls a store-level backend with checked
// arguments. The backend is the local backend (adapters/reference/backend) or the public API client
// (adapters/http/lib/api-backend.mjs); its methods may be synchronous or return promises:
//   get, put, remove, increment, batchGet, lookup, count, query, append, ledgerStatus, ledgerProof, transact
//   (async or sync), storeFormat(storeId) (sync). A read record is { key, raw, encrypted, ... } or null.
// buildKvStore already does open(), handle get options, the second commit, iteration and verifyChain.
// append without an idempotencyKey: the edge generates 'q_' + 32 hex for the call, passes it to the backend as an
// automatic key, and names it on any error of the call (d.ts AppendOptions).
import { randomBytes } from 'node:crypto';

const SET_NAMES = ['ttl', 'secret', 'ifAbsent', 'ifVersion'];
const DELETE_NAMES = ['ifVersion'];

/** Only the option names the backend knows, with defined values. */
function known(options, names) {
  const out = {};
  for (const name of names) if (options?.[name] !== undefined) out[name] = options[name];
  return out;
}

const autoKey = () => `q_${randomBytes(16).toString('hex')}`;

function entryOf(record) {
  if (record === null) return null;
  const { raw, ...rest } = record;
  return { ...rest, value: JSON.parse(raw) };
}

export function createEdgeCalls({ backend, checks, KVError, isAllowed, warn = () => {} }) {
  const validation = (message) => new KVError('VALIDATION', message);

  // Checks the store id, runs the argument checks, then the allow-list.
  function guard(storeId, argumentChecks = () => {}) {
    checks.checkStoreId(storeId);
    argumentChecks();
    if (!isAllowed(storeId)) {
      throw new KVError('FORBIDDEN', `access to KV store ${storeId} is not allowed`, { status: 403 });
    }
  }

  const keyCheck = (storeId, key) => () => checks.checkKey(key, { format: isAllowed(storeId) ? backend.storeFormat(storeId) : 2 });

  function encode(value) {
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = undefined;
    }
    if (typeof raw !== 'string') throw validation('the value must be JSON-serialisable');
    return raw;
  }

  const warnUnknown = (unknown, what) => {
    for (const name of unknown) warn(`unknown ${what} option ignored: ${name}`);
  };

  const OPS = {
    check: (op) => ({ op: 'check', key: op.key, version: op.version }),
    set: (op) => ({ op: 'set', key: op.key, raw: encode(op.value), options: known(op.options, SET_NAMES) }),
    delete: (op) => ({ op: 'delete', key: op.key, options: known(op.options, DELETE_NAMES) }),
    increment: (op) => ({ op: 'increment', key: op.key, amount: op.amount ?? 1 }),
  };

  return {
    async get(storeId, key, skipDecode) {
      guard(storeId, keyCheck(storeId, key));
      const record = await backend.get(storeId, key);
      if (record === null) return null;
      return skipDecode ? record.raw : JSON.parse(record.raw);
    },
    async set(storeId, key, value, options) {
      let raw;
      guard(storeId, () => {
        keyCheck(storeId, key)();
        warnUnknown(checks.checkSetOptions(options).unknown, 'set');
        raw = encode(value);
      });
      const result = await backend.put(storeId, key, raw, known(options, SET_NAMES));
      const conditional = options?.ifAbsent !== undefined || options?.ifVersion !== undefined;
      return conditional ? { version: result.version } : true;
    },
    async delete(storeId, key, options) {
      guard(storeId, () => {
        keyCheck(storeId, key)();
        warnUnknown(checks.checkDeleteOptions(options).unknown, 'delete');
      });
      return await backend.remove(storeId, key, known(options, DELETE_NAMES));
    },
    async getEntry(storeId, key) {
      guard(storeId, keyCheck(storeId, key));
      return entryOf(await backend.get(storeId, key));
    },
    async getMany(storeId, keys) {
      guard(storeId, () => checks.checkGetMany(keys));
      return (await backend.batchGet(storeId, keys)).map(entryOf);
    },
    async getBy(storeId, index, equals) {
      guard(storeId, () => checks.checkIndexArgs(index, equals));
      return entryOf(await backend.lookup(storeId, index, equals));
    },
    async count(storeId, options) {
      guard(storeId, () => checks.checkIndexArgs(options?.index, options?.equals, { min: 0 }));
      return await backend.count(storeId, { index: options.index, equals: options.equals });
    },
    async increment(storeId, key, amount, options) {
      guard(storeId, () => checks.checkIncrement(key, amount, options));
      return await backend.increment(storeId, key, amount ?? 1, known(options, ['ttl']));
    },
    async list(storeId, options) {
      guard(storeId, () => checks.checkQueryOptions(options));
      return await backend.query(storeId, options ?? {}, { search: false });
    },
    async search(storeId, options) {
      guard(storeId, () => checks.checkQueryOptions(options, { search: true }));
      return await backend.query(storeId, options ?? {}, { search: true });
    },
    async append(storeId, collection, value, options) {
      const given = options?.idempotencyKey;
      const auto = autoKey();
      try {
        guard(storeId, () => checks.checkAppend(collection, value, options));
        return await backend.append(storeId, collection, value, { idempotencyKey: given ?? auto, auto: given === undefined });
      } catch (err) {
        if (given === undefined && err instanceof KVError && err.idempotencyKey === undefined) err.idempotencyKey = auto;
        throw err;
      }
    },
    async ledgerStatus(storeId, name) {
      guard(storeId, () => checks.checkLedgerName(name));
      return await backend.ledgerStatus(storeId, name);
    },
    async ledgerProof(storeId, name, key) {
      guard(storeId, () => {
        checks.checkLedgerName(name);
        checks.checkProofKey(key);
      });
      return await backend.ledgerProof(storeId, name, key);
    },
    async atomic(storeId, ops, commitOptions) {
      let mapped;
      guard(storeId, () => {
        warnUnknown(checks.checkTransaction(ops, commitOptions).unknown, 'transaction');
        mapped = ops.map((op) => OPS[op.op](op));
      });
      return await backend.transact(storeId, mapped, known(commitOptions, ['idempotencyKey']));
    },
  };
}
