// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// snapshot() and restore(snapshot): a JSON-safe copy of the backend state. Maps become arrays of [name, value]
// pairs. The copy holds the local keys (secret and cursor), so a restored backend reads its secret values: this is
// a local reference backend, not a production store. Later features add their per-store maps to STORE_MAPS.
// Ledger subject keys are in the copy too (the reference keys, the ref and token rows, the listings and the erasure
// records; subjectKeys of the retired format), for the same reason, and so is the archive signing key. A snapshot
// of an earlier version has no subject maps: they start empty.
import { newStore } from './core.mjs';

export const SNAPSHOT_VERSION = 1;
const STORE_MAPS = ['items', 'idempotency', 'indexes', 'ledgers', 'chains', 'subjectKeys', 'archives', 'digests',
  'subjectRefKeys', 'subjectRefs', 'subjectTokens', 'subjectListings', 'shreds'];

const clone = (value) => JSON.parse(JSON.stringify(value));

function storeOut(store) {
  const out = { id: store.id, format: store.format };
  for (const name of STORE_MAPS) out[name] = clone([...store[name].entries()]);
  return out;
}

function storeIn(data) {
  const store = newStore(data.id, data.format);
  for (const name of STORE_MAPS) store[name] = new Map(clone(data[name] ?? []));
  return store;
}

export function takeSnapshot(core, keys) {
  return {
    v: SNAPSHOT_VERSION,
    offsetMs: core.offsetMs,
    versionSeq: core.versionSeq,
    rngState: core.rngState,
    keys: { ...keys },
    stores: [...core.stores.values()].map(storeOut),
  };
}

/** Replaces the core state with the snapshot. Returns the keys it holds. */
export function applySnapshot(core, snapshot) {
  if (snapshot?.v !== SNAPSHOT_VERSION || !Array.isArray(snapshot.stores)) {
    throw new TypeError(`restore takes a snapshot of version ${SNAPSHOT_VERSION}`);
  }
  core.offsetMs = snapshot.offsetMs ?? 0;
  core.versionSeq = snapshot.versionSeq ?? 0;
  core.rngState = snapshot.rngState ?? core.rngState;
  core.stores = new Map(snapshot.stores.map((data) => [data.id, storeIn(data)]));
  return { ...snapshot.keys };
}
