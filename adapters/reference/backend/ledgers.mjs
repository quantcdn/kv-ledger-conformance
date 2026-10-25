// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Ledgers of a store (ledgers page "Declare a Ledger"; spec 9.1): declare and drop, the state on the injected clock
// (PENDING until activeAfter, then ACTIVE, or FAILED when a normal key was written into the collection in the
// window), the immutability rule, status and proofs.
// store.ledgers: Map name -> { definition, definitionHash, state, activeAfterMs, error? }.
// store.chains: Map `${collection}#${shard}` -> { ledger, collection, shard, seq, hash, at, random, keys[] }.
// The archive (archived seq, proofs, retention) is a seam: `archive` answers for it (./archive.mjs fills it in).
// Status and proof calls first let the archive catch up with the clock (archive.refresh).
import { LIMITS } from '../../../lib/limits.mjs';
import { definitionHash } from '../../../lib/ledger-bytes.mjs';
import { byteCompare } from '../../../lib/check-util.mjs';
import { collectionOf } from './core.mjs';
import { covers } from './index-defs.mjs';
import { completeDefinition, ledgerDefinitionProblem, needsSubject, patternsOverlap } from './ledger-defs.mjs';

/** The archive seam before archives exist: nothing is archived, every proof is pending. */
export const NO_ARCHIVE = Object.freeze({
  archivedSeq: () => 0,
  proofOf: () => ({ status: 'pending' }),
  refresh: () => {},
  retainUntil: () => null,
});

const iso = (ms) => new Date(ms).toISOString();
// Instances in UTF-8 byte order of the collection, then of the shard.
const byInstance = (a, b) => byteCompare(a.collection, b.collection) || byteCompare(a.shard, b.shard);

export function createLedgers(core, { archive = NO_ARCHIVE } = {}) {
  const notFound = (name) => core.error('LEDGER_NOT_FOUND', `no ledger named ${name}`, { ledger: name });

  // Normal (non-ledger) items in collections that the pattern covers.
  const normalKeysIn = (store, pattern) => [...store.items.entries()]
    .filter(([key, record]) => record.ledger === undefined && covers(pattern, collectionOf(key)));

  function refreshed(store, entry) {
    if (entry.state !== 'PENDING' || core.now() < entry.activeAfterMs) return entry;
    const dirty = normalKeysIn(store, entry.definition.collection).length > 0;
    entry.state = dirty ? 'FAILED' : 'ACTIVE';
    if (dirty) entry.error = 'LEDGER_COLLECTION_NOT_EMPTY';
    return entry;
  }

  const entries = (store) => [...store.ledgers.values()].map((entry) => refreshed(store, entry));

  /** The ledger (not FAILED) whose collection covers the concrete collection, or undefined. */
  const covering = (store, collection) => entries(store)
    .find((e) => e.state !== 'FAILED' && covers(e.definition.collection, collection));

  function checkRoom(store, def) {
    const others = entries(store).filter((e) => e.definition.name !== def.name);
    const same = store.ledgers.get(def.name);
    if (same !== undefined && refreshed(store, same).state !== 'FAILED') {
      throw core.error('VALIDATION', `a ledger named ${def.name} exists`, { ledger: def.name });
    }
    if (others.length >= LIMITS.ledgersPerStore) throw core.error('LIMIT_EXCEEDED', 'too many ledgers', { status: 400 });
    const overlap = others.find((e) => e.state !== 'FAILED' && patternsOverlap(e.definition.collection, def.collection));
    if (overlap) throw core.error('VALIDATION', `the collection belongs to ledger ${overlap.definition.name}`);
    if (normalKeysIn(store, def.collection).length > 0) {
      throw core.error('LEDGER_COLLECTION_NOT_EMPTY', 'the collection holds keys', { reason: 'not_empty' });
    }
  }

  function declareLedger(storeId, def, { wait = true } = {}) {
    const store = core.needStore(storeId);
    const problem = ledgerDefinitionProblem(def);
    if (problem !== null) throw core.error('VALIDATION', problem);
    if (needsSubject(def)) throw core.error('LEDGER_SUBJECT_REQUIRED', 'personalFields need a subjectField');
    checkRoom(store, def);
    const now = core.now();
    const definition = completeDefinition(def, now);
    const entry = { definition, definitionHash: definitionHash(definition), state: wait ? 'ACTIVE' : 'PENDING',
      activeAfterMs: now + LIMITS.ledgerActivationMs };
    store.ledgers.set(def.name, entry);
    return { name: def.name, state: entry.state, definition: structuredClone(definition),
      definitionHash: entry.definitionHash, activeAfter: iso(entry.activeAfterMs) };
  }

  const chainsOf = (store, name) => [...store.chains.values()].filter((c) => c.ledger === name).sort(byInstance);

  // LEDGER_RETAINED while an entry waits for the archive, or before the retention of the archive objects ends.
  function checkRetention(store, entry) {
    const name = entry.definition.name;
    const unarchived = chainsOf(store, name).find((c) => archive.archivedSeq(store, c) < c.seq);
    if (unarchived) {
      throw core.error('LEDGER_RETAINED', `ledger ${name} has entries that are not archived`,
        { reason: 'unarchived', collection: unarchived.collection, shard: unarchived.shard });
    }
    const until = archive.retainUntil(store, entry);
    if (until !== null && core.now() < until) {
      throw core.error('LEDGER_RETAINED', `ledger ${name} is retained`, { retainUntil: iso(until) });
    }
  }

  function dropLedger(storeId, name) {
    const store = core.needStore(storeId);
    const entry = store.ledgers.get(name);
    if (entry === undefined) throw notFound(name);
    const { state } = refreshed(store, entry);
    if (state === 'PENDING' || state === 'FAILED') store.ledgers.delete(name);
    if (state !== 'ACTIVE') return true;
    checkRetention(store, entry);
    entry.state = 'DROPPED';
    return true;
  }

  /** The ledger entry by name, brought up to the clock; LEDGER_NOT_FOUND when absent. */
  function needLedger(store, name) {
    const entry = store.ledgers.get(name);
    if (entry === undefined) throw notFound(name);
    return refreshed(store, entry);
  }

  function shardStatus(store, chain) {
    const archivedSeq = archive.archivedSeq(store, chain);
    const oldest = archivedSeq < chain.seq ? store.items.get(chain.keys[archivedSeq]).ledger.at : null;
    const lag = oldest === null ? 0 : Math.max(0, Math.floor((core.now() - oldest) / 1000));
    return { collection: chain.collection, shard: chain.shard, headSeq: chain.seq, archivedSeq, lag, headAt: chain.at };
  }

  function ledgerStatus(storeId, name) {
    const store = core.needStore(storeId);
    const entry = needLedger(store, name);
    archive.refresh(store);
    const shards = chainsOf(store, name).map((chain) => shardStatus(store, chain));
    const sum = (field) => shards.reduce((total, s) => total + s[field], 0);
    const out = { name, state: entry.state, collection: entry.definition.collection, chains: entry.definition.chains,
      headSeq: sum('headSeq'), archivedSeq: sum('archivedSeq'), lag: Math.max(0, ...shards.map((s) => s.lag)),
      shards, hasMoreShards: false };
    if (entry.state === 'PENDING') out.activeAfter = iso(entry.activeAfterMs);
    const until = archive.retainUntil(store, entry);
    if (until !== null) out.retainUntil = iso(until);
    return out;
  }

  function ledgerProof(storeId, name, key) {
    const store = core.needStore(storeId);
    const entry = needLedger(store, name);
    const record = store.items.get(key);
    if (record?.ledger?.name !== name) throw core.error('NOT_FOUND', `no entry ${key} in ledger ${name}`, { key });
    archive.refresh(store);
    return archive.proofOf(store, entry, key, record);
  }

  /** LEDGER_IMMUTABLE for a write to a ledger entry or into an ACTIVE or DROPPED ledger collection. */
  function checkMutable(store, key) {
    const isEntry = store.items.get(key)?.ledger !== undefined;
    const ledger = isEntry ? undefined : covering(store, collectionOf(key));
    if (isEntry || (ledger !== undefined && ledger.state !== 'PENDING')) {
      throw core.error('LEDGER_IMMUTABLE', `${key} is in a ledger and cannot change`, { key });
    }
  }

  /** True when a ledger (in any state but FAILED) covers the concrete collection. */
  const isLedgerCollection = (store, collection) => covering(store, collection) !== undefined;

  return { declareLedger, dropLedger, ledgerStatus, ledgerProof, covering, refreshed, checkMutable, isLedgerCollection,
    iso };
}
