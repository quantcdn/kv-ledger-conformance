// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Edge-layer argument checks, shared by the reference and HTTP adapters. Each check throws
// new KVError('VALIDATION', message[, { hint }]) with no status, before any store work.
// createEdgeChecks(KVError) binds the checks to the adapter's own KVError class, the same class that
// buildKvStore(base, KVError) exposes as kvStore.KVError, so `instanceof kvStore.KVError` holds.
import { LIMITS } from './limits.mjs';
import {
  isAmount, isBoolean, isIntIn, isNonEmptyString, isPlainObject, isScalarMap, isTtl, keyProblem, scanOptions,
  utf8Bytes,
} from './check-util.mjs';
import { queryProblem } from './query-checks.mjs';

const SET_SPEC = { ttl: isTtl, secret: isBoolean, ifAbsent: (v) => v === true, ifVersion: isNonEmptyString };
const DELETE_SPEC = { ifVersion: isNonEmptyString };
const INCREMENT_SPEC = { ttl: isTtl };
const IDEMPOTENCY_SPEC = { idempotencyKey: (v) => typeof v === 'string' && LIMITS.idempotencyKey.pattern.test(v) };

const isCollection = (v) => isNonEmptyString(v) && utf8Bytes(v) <= LIMITS.ledgerCollectionMaxBytes;

export function createEdgeChecks(KVError) {
  if (typeof KVError !== 'function') throw new TypeError('createEdgeChecks needs a KVError class');

  const fail = (message, details) => {
    throw new KVError('VALIDATION', message, details);
  };
  const ensure = (ok, message) => {
    if (!ok) fail(message);
  };

  // Throws for a problem from scanOptions; returns the unknown names.
  function settle(scan) {
    if (scan.problem !== undefined) fail(scan.problem, scan.hint === undefined ? undefined : { hint: scan.hint });
    return scan.unknown;
  }

  function refuseUnknown(scan, what) {
    const unknown = settle(scan);
    ensure(unknown.length === 0, `Unknown ${what} option: ${unknown[0]}`);
  }

  function checkStoreId(storeId) {
    ensure(typeof storeId === 'string' && LIMITS.storeId.test(storeId), 'storeId must match [A-Za-z0-9_-]');
  }

  function checkKey(key, { format = 2 } = {}) {
    const problem = keyProblem(key, format);
    if (problem !== null) fail(problem);
  }

  function checkSetOptions(opts) {
    const unknown = settle(scanOptions(opts, SET_SPEC, 'set'));
    ensure(opts?.ifAbsent === undefined || opts?.ifVersion === undefined, 'ifAbsent and ifVersion cannot be combined');
    return { unknown };
  }

  function checkDeleteOptions(opts) {
    return { unknown: settle(scanOptions(opts, DELETE_SPEC, 'delete')) };
  }

  function checkAmount(amount) {
    ensure(amount === undefined || isAmount(amount), 'amount must be a nonzero safe integer');
  }

  function checkIncrement(key, amount, opts) {
    checkKey(key);
    checkAmount(amount);
    refuseUnknown(scanOptions(opts, INCREMENT_SPEC, 'increment'), 'increment');
  }

  function checkGetMany(keys) {
    ensure(Array.isArray(keys) && isIntIn(keys.length, { min: LIMITS.getMany.minKeys, max: LIMITS.getMany.maxKeys }),
      'getMany takes an array within the key count limits');
    for (const key of keys) checkKey(key, { format: 1 });
  }

  function checkQueryOptions(opts, { search = false } = {}) {
    const problem = queryProblem(opts, { search });
    if (problem !== null) fail(problem);
  }

  const OP_CHECKS = {
    check: (op) => {
      ensure(op.version === null || isNonEmptyString(op.version), 'check version must be a non-empty string or null');
      return [];
    },
    set: (op) => checkSetOptions(op.options).unknown,
    delete: (op) => checkDeleteOptions(op.options).unknown,
    increment: (op) => {
      checkAmount(op.amount);
      return [];
    },
  };

  function checkOp(op) {
    ensure(isPlainObject(op) && Object.hasOwn(OP_CHECKS, op.op), 'unknown transaction operation');
    checkKey(op.key);
    return OP_CHECKS[op.op](op);
  }

  /** ops: [{ op: 'check', key, version } | { op: 'set', key, value, options? } | { op: 'delete', key, options? }
   *  | { op: 'increment', key, amount? }]. Returns { unknown } (set/delete option names to warn about). */
  function checkTransaction(ops, opts) {
    ensure(Array.isArray(ops) && isIntIn(ops.length, { min: LIMITS.transaction.minOps, max: LIMITS.transaction.maxOps }),
      'a transaction has a number of operations within the transaction limits');
    const unknown = [];
    const seen = new Set();
    for (const op of ops) {
      unknown.push(...checkOp(op));
      ensure(!seen.has(op.key), 'a key appears twice in the transaction');
      seen.add(op.key);
    }
    refuseUnknown(scanOptions(opts, IDEMPOTENCY_SPEC, 'commit'), 'commit');
    return { unknown };
  }

  function checkAppend(collection, value, opts) {
    ensure(isCollection(collection), 'collection must be a non-empty string within the collection byte limit');
    ensure(isPlainObject(value), 'value must be a plain object');
    refuseUnknown(scanOptions(opts, IDEMPOTENCY_SPEC, 'append'), 'append');
  }

  function checkLedgerName(name) {
    ensure(typeof name === 'string' && LIMITS.ledgerName.test(name), 'invalid ledger name');
  }

  function checkProofKey(key) {
    checkKey(key);
  }

  /** getBy: min 1 (equals required). count: min 0 (equals may be omitted or {}). */
  function checkIndexArgs(index, equals, { min = 1 } = {}) {
    ensure(typeof index === 'string' && LIMITS.indexName.test(index), 'invalid index name');
    if (equals === undefined && min === 0) return;
    ensure(isScalarMap(equals, min, LIMITS.equalsFields.max), 'equals must be an object of scalar fields within the limit');
  }

  return Object.freeze({
    checkStoreId, checkKey, checkSetOptions, checkDeleteOptions, checkIncrement, checkGetMany, checkQueryOptions,
    checkTransaction, checkAppend, checkLedgerName, checkProofKey, checkIndexArgs,
  });
}
