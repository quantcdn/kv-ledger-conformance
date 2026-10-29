// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Subject keys of the ledgers of a store (subject contract version 1), as the platform keeps them, with local keys in
// place of KMS (docs/subject-v1-local.md):
// - store.subjectRefKeys: version -> { key (base64, 32 bytes), state: 'current', createdAt }. The store's subject
//   reference key. Made by the first write that needs it. Only version 1: the backend does not rotate it.
// - store.subjectRefs: `<ledger>#<subjectRef>` -> the ref row: live { token, key, gen, refKeyVersion, shredIds,
//   shredGens } or shredded { gen, refKeyVersion, shreddedAt, shredRefVersion, shredIds, shredGens } (no token, no key).
// - store.subjectTokens: `<ledger>#<token>` -> { key } (live) or { shredded: true }. Reads find a key by the token that
//   an entry stores; an entry of a shredded generation names a tombstoned token and reads as shredded.
// - store.subjectListings: `<ledger>#<subjectRef>` -> the collections that hold entries of the subject (sorted).
// subjectRef = HMAC-SHA256(k_1, "qkv-subject-ref-v2\n<ledger>\n<canonical id>"), the first 32 hex characters.
import { createHmac, randomBytes } from 'node:crypto';
import { byteCompare } from '../../../lib/check-util.mjs';
import { base32 } from './ledger-ids.mjs';

export const SUBJECT_REF_LABEL = 'qkv-subject-ref-v2';
export const SUBJECT_TOKEN_PATTERN = /^qsub1_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// A write after a shred waits this long before it makes the next key generation.
export const SHRED_SETTLE_MS = 60_000;
const KEY_BYTES = 32;
const REF_KEY_VERSION = 1;

const rowId = (ledger, name) => `${ledger}#${name}`;

/** A new subject token: 'qsub1_' and 128 random bits as 26 Crockford base32 digits. */
export const newSubjectToken = () => `qsub1_${base32(BigInt(`0x${randomBytes(16).toString('hex')}`), 26)}`;
export const isSubjectToken = (v) => typeof v === 'string' && SUBJECT_TOKEN_PATTERN.test(v);
const newGeneration = () => randomBytes(16).toString('hex');
const newKey = () => randomBytes(KEY_BYTES).toString('base64');

/** The version-1 reference of a subject in a ledger (pure). */
export const subjectRefV1 = (key, ledger, canonicalId) => createHmac('sha256', key)
  .update(`${SUBJECT_REF_LABEL}\n${ledger}\n${canonicalId}`).digest('hex').slice(0, 32);

/** The subject state of a ref row: { state: 'absent' }, live { state, token, key, gen, ... } or shredded. */
export function stateOf(row) {
  if (row === undefined) return { state: 'absent' };
  const common = { gen: row.gen, refKeyVersion: row.refKeyVersion, shredIds: row.shredIds ?? [],
    shredGens: row.shredGens ?? {} };
  if (typeof row.token === 'string') return { state: 'live', token: row.token, key: row.key, ...common };
  return { state: 'shredded', shreddedAt: row.shreddedAt, shredRefVersion: row.shredRefVersion ?? row.refKeyVersion,
    ...common };
}

export function createSubjectKeys(core) {
  const contention = (message) => core.error('CONTENTION', message);

  /** The store's reference key (Buffer), or undefined when it has none and `create` is false. */
  function refKey(store, create) {
    if (!store.subjectRefKeys.has(REF_KEY_VERSION) && create) {
      store.subjectRefKeys.set(REF_KEY_VERSION,
        { key: newKey(), state: 'current', createdAt: new Date(core.now()).toISOString() });
    }
    const row = store.subjectRefKeys.get(REF_KEY_VERSION);
    return row === undefined ? undefined : Buffer.from(row.key, 'base64');
  }

  /** { ref, refKeyVersion, state } of the subject, or undefined when the store has no reference key yet. A read
   *  (create false) never writes. */
  function findSubject(store, ledger, canonicalId, { create = false } = {}) {
    const key = refKey(store, create);
    if (key === undefined) return undefined;
    const ref = subjectRefV1(key, ledger, canonicalId);
    return { ref, refKeyVersion: REF_KEY_VERSION, state: stateOf(store.subjectRefs.get(rowId(ledger, ref))) };
  }

  /** Records that `collection` holds entries of the subject (the shred appends to each listed collection). */
  function addListing(store, ledger, ref, collection) {
    const id = rowId(ledger, ref);
    const listed = store.subjectListings.get(id) ?? [];
    if (!listed.includes(collection)) store.subjectListings.set(id, [...listed, collection].sort(byteCompare));
  }

  const listingsOf = (store, ledger, ref) => [...(store.subjectListings.get(rowId(ledger, ref)) ?? [])];

  // A reissue after a shred carries the shred ids, and maps the last shred id to the generation it tombstoned.
  function carried(seen) {
    if (seen.state !== 'shredded') return { shredIds: [], shredGens: {} };
    const last = seen.shredIds[seen.shredIds.length - 1];
    return { shredIds: [...seen.shredIds], shredGens: last === undefined ? { ...seen.shredGens }
      : { ...seen.shredGens, [last]: seen.gen } };
  }

  function refuseUnsettled(seen) {
    if (seen.state !== 'shredded') return;
    if (!(core.now() - Date.parse(seen.shreddedAt) >= SHRED_SETTLE_MS)) {
      throw contention('This data subject was shredded moments ago; retry shortly');
    }
  }

  /** The live key (Buffer), token and gen of the subject at `ref`; makes the first (or, after a shred, the next)
   *  generation. CONTENTION within SHRED_SETTLE_MS of a shred. */
  function keyForWrite(store, ledger, ref) {
    const seen = stateOf(store.subjectRefs.get(rowId(ledger, ref)));
    if (seen.state === 'live') return { key: Buffer.from(seen.key, 'base64'), token: seen.token, gen: seen.gen };
    refuseUnsettled(seen);
    const made = { token: newSubjectToken(), key: newKey(), gen: newGeneration() };
    store.subjectRefs.set(rowId(ledger, ref), { ...made, refKeyVersion: REF_KEY_VERSION, ...carried(seen) });
    store.subjectTokens.set(rowId(ledger, made.token), { key: made.key });
    return { key: Buffer.from(made.key, 'base64'), token: made.token, gen: made.gen };
  }

  /** By token: the key (Buffer) of a live token, null for a tombstoned one. A token with no row is left out. */
  function keysForRead(store, ledger, tokens) {
    const out = new Map();
    for (const token of new Set(tokens)) {
      const row = store.subjectTokens.get(rowId(ledger, token));
      if (row !== undefined) out.set(token, row.shredded === true ? null : Buffer.from(row.key, 'base64'));
    }
    return out;
  }

  /** Destroys the live key of the subject at `ref`: the ref row and the token row become tombstones. */
  function tombstone(store, ledger, ref, shredId) {
    const id = rowId(ledger, ref);
    const seen = stateOf(store.subjectRefs.get(id));
    const shreddedAt = new Date(core.now()).toISOString();
    store.subjectRefs.set(id, { gen: seen.gen, refKeyVersion: seen.refKeyVersion, shreddedAt,
      shredRefVersion: seen.refKeyVersion, shredIds: [...seen.shredIds, shredId(shreddedAt)], shredGens: seen.shredGens });
    store.subjectTokens.set(rowId(ledger, seen.token), { shredded: true });
    return shreddedAt;
  }

  return { findSubject, addListing, listingsOf, keyForWrite, keysForRead, tombstone };
}
