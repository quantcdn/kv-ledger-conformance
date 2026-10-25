// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Indexes of a store: declare and drop, the build state on the injected clock (BUILDING until
// LIMITS.indexActivationMs after the declaration, or at once with wait), the backfill check at activation, the
// rules writes must follow, and reads (lookup, count, list candidates). Index contents are derived from the live
// items on each read, so lists by index are strongly consistent here.
// store.indexes: Map name -> { def, activeAt, state: 'BUILDING' | 'ACTIVE' | 'FAILED', error? }.
import { LIMITS } from '../../../lib/limits.mjs';
import { collectionOf, isLive } from './core.mjs';
import {
  comparePositions, compareValues, covers, definitionProblem, normalized, positionOf, tupleOf, tupleOfEquals,
} from './index-defs.mjs';

// A ledger entry also has the server time in a top-level `at` field for indexing (ledgers page).
function parse(record) {
  if (record.encrypted) return undefined;
  const value = JSON.parse(record.raw);
  return record.ledger === undefined ? value : { ...value, at: record.ledger.at };
}

export function createIndexes(core) {
  const validation = (message, details) => core.error('VALIDATION', message, details);

  // Live items in collections the index covers: [{ key, record }].
  function covered(store, def) {
    const now = core.now();
    return [...store.items.entries()]
      .filter(([key, record]) => isLive(record, now) && covers(def.collection, collectionOf(key)))
      .map(([key, record]) => ({ key, record }));
  }

  // Members of the index: covered plaintext items that hold every field, with their tuple.
  function members(store, def) {
    return covered(store, def)
      .map((row) => ({ ...row, value: parse(row.record) }))
      .map((row) => ({ ...row, tuple: row.record.encrypted ? null : tupleOf(def.fields, row.value) }))
      .filter((row) => row.tuple !== null);
  }

  // The first problem the existing items give the index, as an error code, or null.
  function backfillError(store, def) {
    const rows = covered(store, def);
    if (rows.some((row) => row.record.encrypted)) return 'INDEX_FIELD_ENCRYPTED';
    if (def.count && rows.some((row) => row.record.expiresAt !== null)) return 'COUNT_WITH_TTL';
    const tuples = members(store, def).map((row) => row.tuple);
    return def.unique && new Set(tuples).size !== tuples.length ? 'UNIQUE_VIOLATION' : null;
  }

  function activate(store, entry) {
    const error = backfillError(store, entry.def);
    entry.state = error === null ? 'ACTIVE' : 'FAILED';
    if (error !== null) entry.error = error;
  }

  // The entry with its state brought up to the clock.
  function refreshed(store, entry) {
    if (entry.state === 'BUILDING' && core.now() >= entry.activeAt) activate(store, entry);
    return entry;
  }

  function checkRoom(store, def) {
    const all = [...store.indexes.values()];
    if (store.indexes.has(def.name)) throw validation(`an index named ${def.name} exists`, { index: def.name });
    const tooMany = all.length >= LIMITS.indexesPerStore
      || all.filter((e) => e.def.collection === def.collection).length >= LIMITS.indexesPerCollection;
    if (tooMany) throw core.error('LIMIT_EXCEEDED', 'too many indexes', { status: 400, index: def.name });
  }

  function declareIndex(storeId, given, { wait = true } = {}) {
    const store = core.needStore(storeId);
    const problem = definitionProblem(given);
    if (problem !== null) throw validation(problem);
    const def = normalized(given);
    checkRoom(store, def);
    const entry = { def, activeAt: core.now() + LIMITS.indexActivationMs, state: 'BUILDING' };
    store.indexes.set(def.name, entry);
    if (wait) activate(store, entry);
    return { name: def.name, state: entry.state, ...(entry.error ? { error: entry.error } : {}) };
  }

  function dropIndex(storeId, name) {
    const store = core.needStore(storeId);
    if (!store.indexes.delete(name)) throw core.error('NOT_FOUND', `no index named ${name}`, { index: name });
    return true;
  }

  /** The ACTIVE index entry for a read; NOT_FOUND or INDEX_NOT_READY otherwise. kind: 'unique' | 'count'. */
  function readable(store, name, kind) {
    const entry = store.indexes.get(name);
    if (entry === undefined) throw core.error('NOT_FOUND', `no index named ${name}`, { index: name });
    if (kind !== undefined && !entry.def[kind]) throw validation(`index ${name} is not a ${kind} index`, { index: name });
    const { state } = refreshed(store, entry);
    if (state !== 'ACTIVE') throw core.error('INDEX_NOT_READY', `index ${name} is ${state}`, { index: name, state });
    return entry.def;
  }

  function wantedTuple(def, equals) {
    const tuple = tupleOfEquals(def.fields, equals);
    if (tuple === null) throw validation(`equals must name exactly the fields of index ${def.name}`, { index: def.name });
    return tuple;
  }

  function lookup(store, name, equals) {
    const def = readable(store, name, 'unique');
    const tuple = wantedTuple(def, equals);
    return members(store, def).find((row) => row.tuple === tuple) ?? null;
  }

  function count(store, name, equals) {
    const def = readable(store, name, 'count');
    const tuple = wantedTuple(def, equals);
    return members(store, def).filter((row) => row.tuple === tuple).length;
  }

  return { declareIndex, dropIndex, lookup, count, members, readable, wantedTuple, refreshed };
}

// [applies, the row is in range] for after/before on the sortBy value (or the key without sortBy).
const BOUNDS = [
  ['after', (sort, bound) => compareValues(sort, bound) > 0],
  ['before', (sort, bound) => compareValues(sort, bound) < 0],
];

/** List candidates of an index query: { keys, positionOf(key), compare(a, b) } in page order. */
export function indexCandidates(indexes, store, o) {
  const def = indexes.readable(store, o.index);
  const tuple = indexes.wantedTuple(def, o.equals);
  const bounds = BOUNDS.filter(([name]) => Object.hasOwn(o, name));
  const rows = indexes.members(store, def)
    .filter((row) => row.tuple === tuple)
    .map((row) => ({ key: row.key, position: positionOf(def, row.key, row.value) }))
    .filter(({ position }) => bounds.every(([name, inRange]) => inRange(position.missing ? undefined : position.sort, o[name])));
  const direction = o.reverse === true ? -1 : 1;
  rows.sort((a, b) => direction * comparePositions(a.position, b.position));
  const positions = new Map(rows.map((row) => [row.key, row.position]));
  return {
    keys: rows.map((row) => row.key),
    positionOf: (key) => positions.get(key),
    beyond: (key, position) => direction * comparePositions(positions.get(key), position) > 0,
  };
}

/** The rules a write into an indexed collection must follow. Throws the store-level error, or returns. */
export function createWriteRules(core, indexes) {
  // Indexes (not FAILED) whose collection pattern covers the key.
  const coveringOf = (store, key) => [...store.indexes.values()]
    .map((entry) => indexes.refreshed(store, entry))
    .filter((entry) => entry.state !== 'FAILED' && covers(entry.def.collection, collectionOf(key)))
    .map((entry) => entry.def);

  function checkUnique(store, def, key, value) {
    const tuple = tupleOf(def.fields, value);
    if (tuple === null) return;
    const owner = indexes.members(store, def).find((row) => row.tuple === tuple && row.key !== key);
    if (owner !== undefined) {
      throw core.error('UNIQUE_VIOLATION', `index ${def.name} already holds this value`,
        { index: def.name, existingKey: owner.key, key });
    }
  }

  function checkSet(store, key, raw, { secret, ttl } = {}) {
    const defs = coveringOf(store, key);
    if (defs.length === 0) return;
    if (secret === true) throw core.error('INDEX_FIELD_ENCRYPTED', 'a secret value in an indexed collection', { key });
    const counted = defs.find((def) => def.count);
    if (ttl !== undefined && counted) throw core.error('COUNT_WITH_TTL', 'a ttl in a counted collection', { key, index: counted.name });
    const value = JSON.parse(raw);
    for (const def of defs.filter((d) => d.unique)) checkUnique(store, def, key, value);
  }

  function checkIncrement(store, key) {
    const [def] = coveringOf(store, key);
    if (def !== undefined) throw core.error('VALIDATION', 'increment in an indexed collection', { key, index: def.name });
  }

  return { checkSet, checkIncrement };
}
