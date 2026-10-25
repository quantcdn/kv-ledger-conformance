// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Values: records, conditions, put, remove, increment and reads. A record is
// { raw | sealed, encrypted, createdAt, updatedAt, expiresAt (epoch ms or null), version }.
// `raw` is the stored text (JSON); a secret record holds `sealed` instead.
import { LIMITS } from '../../../lib/limits.mjs';
import { isLive } from './core.mjs';

// Bytes the backend adds to the key and the value for the item metadata (times, version, flags).
const METADATA_BYTES = 128;

/** Why a condition fails ({ reason, currentVersion? }), or null. ifAbsent: the key must not be live. */
export function conditionProblem(record, now, { ifAbsent, ifVersion } = {}) {
  const live = isLive(record, now);
  if (ifAbsent === true) return live ? { reason: 'exists', currentVersion: record.version } : null;
  if (ifVersion === undefined) return null;
  if (record === undefined) return { reason: 'missing' };
  if (!live) return { reason: 'expired' };
  return record.version === ifVersion ? null : { reason: 'version', currentVersion: record.version };
}

const expiryOf = (now, ttl) => (ttl === undefined ? null : now + ttl * 1000);

// rules: the write rules ({ checkSet, checkIncrement } of the indexes, checkMutable of the ledgers).
// ledgerViews: the read view of ledger entries ({ view(store, key, record) }).
export function createValues(core, sealer, rules, ledgerViews) {
  const conflict = (key, problem, extra = {}) => core.error('CONFLICT',
    `condition failed for ${key}: ${problem.reason}`, { key, ...problem, ...extra });

  function checkSize(key, raw) {
    if (Buffer.byteLength(key) + Buffer.byteLength(raw) + METADATA_BYTES > LIMITS.itemMaxBytes) {
      throw core.error('LIMIT_EXCEEDED', 'the item is over the item size limit', { status: 400, key });
    }
  }

  const textOf = (record) => (record.encrypted ? sealer.open(record.sealed) : record.raw);

  /** A new record for key. `keep` (a live record) keeps createdAt; `expiresAt` overrides the ttl expiry. */
  function makeRecord(raw, { secret = false, ttl, keep, expiresAt } = {}) {
    const now = core.now();
    const body = secret ? { sealed: sealer.seal(raw) } : { raw };
    return {
      ...body,
      encrypted: secret,
      createdAt: keep ? keep.createdAt : now,
      updatedAt: now,
      expiresAt: expiresAt !== undefined ? expiresAt : expiryOf(now, ttl),
      version: core.newVersion(),
    };
  }

  /** The live record of key, or undefined. */
  function live(store, key) {
    const record = store.items.get(key);
    return isLive(record, core.now()) ? record : undefined;
  }

  /** Public read shape: { key, raw, encrypted, version, createdAt, updatedAt, expiresAt? }; a ledger entry has
   *  { key, raw, encrypted, createdAt, updatedAt, ledger } instead (no version). */
  function view(store, key, record) {
    if (record.ledger !== undefined) return ledgerViews.view(store, key, record);
    const out = { key, raw: textOf(record), encrypted: record.encrypted, version: record.version,
      createdAt: record.createdAt, updatedAt: record.updatedAt };
    if (record.expiresAt !== null) out.expiresAt = record.expiresAt;
    return out;
  }

  function writeSet(store, key, raw, options = {}) {
    rules.checkMutable(store, key);
    checkSize(key, raw);
    const problem = conditionProblem(store.items.get(key), core.now(), options);
    if (problem !== null) throw conflict(key, problem);
    rules.checkSet(store, key, raw, options);
    const record = makeRecord(raw, { secret: options.secret === true, ttl: options.ttl, keep: live(store, key) });
    store.items.set(key, record);
    return record;
  }

  function writeDelete(store, key, options = {}) {
    rules.checkMutable(store, key);
    const problem = conditionProblem(store.items.get(key), core.now(), options);
    if (problem !== null) throw conflict(key, problem);
    store.items.delete(key);
  }

  /** The number a live record holds, or null when it is not a plain safe integer. */
  function numberOf(record) {
    if (record.encrypted) return null;
    const value = JSON.parse(record.raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  /** Why an increment of key by amount cannot run ({ reason }), or null. strict: an expired counter fails. */
  function incrementProblem(store, key, amount, { strict = false } = {}) {
    const record = store.items.get(key);
    if (!isLive(record, core.now())) return strict && record !== undefined ? { reason: 'expired' } : null;
    const current = numberOf(record);
    if (current === null) return { reason: 'not_numeric' };
    return Number.isSafeInteger(current + amount) ? null : { reason: 'range' };
  }

  /** Applies an increment that incrementProblem allowed. A live counter keeps its expiry. */
  function writeIncrement(store, key, amount, { ttl } = {}) {
    const record = live(store, key);
    const value = record === undefined ? amount : numberOf(record) + amount;
    const keep = record === undefined ? {} : { keep: record, expiresAt: record.expiresAt };
    store.items.set(key, makeRecord(JSON.stringify(value), { ttl, ...keep }));
    return value;
  }

  const checkIncrement = (store, key) => {
    rules.checkMutable(store, key);
    rules.checkIncrement(store, key);
  };

  return { conflict, checkSize, checkSet: rules.checkSet, checkMutable: rules.checkMutable, checkIncrement, live, view,
    writeSet, writeDelete, incrementProblem, writeIncrement };
}
