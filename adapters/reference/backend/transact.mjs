// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Transactions: all operations or none, CONFLICT with the operation index, and idempotency records (24 h).
// ops: [{ op: 'check', key, version } | { op: 'set', key, raw, options? } | { op: 'delete', key, options? }
//   | { op: 'increment', key, amount }], already checked by the edge layer.
import { LIMITS } from '../../../lib/limits.mjs';
import { conditionProblem } from './values.mjs';

const fingerprintOf = (ops) => JSON.stringify(ops.map(({ op, key, raw, options, amount, version }) => (
  [op, key, raw ?? null, options ?? null, amount ?? null, version ?? null])));

export function createTransactions(core, values, faults) {
  const PROBLEMS = {
    check: (store, op) => conditionProblem(store.items.get(op.key), core.now(),
      op.version === null ? { ifAbsent: true } : { ifVersion: op.version }),
    set: (store, op) => conditionProblem(store.items.get(op.key), core.now(), op.options),
    delete: (store, op) => conditionProblem(store.items.get(op.key), core.now(), op.options),
    increment: (store, op) => values.incrementProblem(store, op.key, op.amount ?? 1, { strict: true }),
  };

  const APPLY = {
    check: () => undefined,
    set: (store, op) => values.writeSet(store, op.key, op.raw, op.options).version,
    delete: (store, op) => {
      values.writeDelete(store, op.key, op.options);
    },
    increment: (store, op) => {
      values.writeIncrement(store, op.key, op.amount ?? 1);
      return store.items.get(op.key).version;
    },
  };

  function verify(store, ops) {
    ops.forEach((op, operation) => {
      if (op.op !== 'check') values.checkMutable(store, op.key);
      if (op.op === 'set') values.checkSize(op.key, op.raw);
      if (op.op === 'increment') values.checkIncrement(store, op.key);
      const problem = PROBLEMS[op.op](store, op);
      if (problem !== null) throw values.conflict(op.key, problem, { operation });
      if (op.op === 'set') values.checkSet(store, op.key, op.raw, op.options);
    });
  }

  function apply(store, ops) {
    const versions = {};
    for (const op of ops) {
      const version = APPLY[op.op](store, op);
      if (version !== undefined) versions[op.key] = version;
    }
    return versions;
  }

  // Two operations of one transaction can still clash with each other (a unique value): undo all on a throw.
  function applyAll(store, ops) {
    const before = new Map(store.items);
    try {
      return apply(store, ops);
    } catch (err) {
      store.items = before;
      throw err;
    }
  }

  /** The earlier result for idempotencyKey within the replay window, or null. A different body is VALIDATION. */
  function replayOf(store, idempotencyKey, fingerprint) {
    const prior = idempotencyKey === undefined ? undefined : store.idempotency.get(idempotencyKey);
    if (prior === undefined || core.now() - prior.at > LIMITS.idempotencyKey.replayWindowMs) return null;
    if (prior.fingerprint !== fingerprint) {
      throw core.error('VALIDATION', 'the idempotencyKey was used with different operations', { idempotencyKey });
    }
    return { versions: { ...prior.versions }, replayed: true };
  }

  function transact(storeId, ops, { idempotencyKey } = {}) {
    const store = core.needStore(storeId);
    const fingerprint = fingerprintOf(ops);
    const replay = replayOf(store, idempotencyKey, fingerprint);
    if (replay !== null) return replay;
    const retryable = idempotencyKey !== undefined;
    const details = retryable ? { idempotencyKey } : {};
    return faults.run('commit', { retryable, details }, () => {
      verify(store, ops);
      const versions = applyAll(store, ops);
      if (retryable) store.idempotency.set(idempotencyKey, { fingerprint, versions, at: core.now() });
      return { versions: { ...versions }, replayed: false };
    });
  }

  return { transact };
}
