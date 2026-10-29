// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The shred of a data subject (the platform route POST …/ledgers/{name}/shred; subject contract v1). A backend
// call, not part of the edge kvStore: shred(storeId, ledger, { subjectId, reason, authority, requestedBy }).
// 1. The id is canonicalised; no ref row: SUBJECT_NOT_FOUND.
// 2. A shred entry { $event: 'shred', subjectRef, reason, authority, requestedBy } goes into every collection listed for
//    the subject (only when the ledger is ACTIVE), from the platform source quant-ledger. It never holds the id.
// 3. Then the key is tombstoned: entries of this generation read { $shredded: true } from then on.
// 4. The erasure record and its receipt, signed with the local archive key (ECDSA P-256 over the SHA-256 of the JCS
//    bytes), are kept: a repeat call writes nothing and answers alreadyShredded with the same record and receipt.
// The local backend runs the whole shred at once, so it never answers 202 (in progress).
import { createHash } from 'node:crypto';
import { byteCompare } from '../../../lib/check-util.mjs';
import { canonicalJson } from '../../../lib/ledger-bytes.mjs';
import { base32 } from './ledger-ids.mjs';
import { canonicalSubjectId } from './subject-canonical.mjs';
import { isRetiredFormat, LEDGER_FORMAT_RETIRED_MESSAGE } from './subject-value.mjs';

export const MAX_SHRED_FIELD_CHARS = 1000;
export const PITR_DAYS = 35;
export const RECEIPT_TYPE = 'kv-ledger-shred-receipt';
export const RECEIPT_ALGORITHM = 'ECDSA_SHA_256';
export const MAX_RECEIPT_ENTRIES_BYTES = 300_000;
const DAY_MS = 86_400_000;
const FIELDS = ['reason', 'authority', 'requestedBy'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_SHRED_FIELD_CHARS;
export const isSubjectValue = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v));

/** The shred id: the ULID time of shreddedAt, then 16 Crockford characters of SHA-256(subjectRef, kind). */
export function shredIdOf(shreddedAt, subjectRef, forked = false) {
  const h = createHash('sha256').update(`${subjectRef}\n${forked ? 'forked' : 'recorded'}`).digest('hex');
  return base32(Date.parse(shreddedAt), 10) + base32(BigInt(`0x${h.slice(0, 20)}`), 16);
}

/** The entries a receipt covers: { key, shard, seq, hash }, sorted by key. */
const shredEntries = (receipts) => receipts.map((r) => ({ key: r.key, shard: r.shard, seq: r.seq, hash: r.hash }))
  .sort((a, b) => byteCompare(a.key, b.key));
const entriesSha256 = (entries) => createHash('sha256').update(canonicalJson(entries)).digest('hex');

/** Shared by the subject calls: the checked ledger and the subject's state (SUBJECT_NOT_FOUND when absent). */
export function createSubjectLookup(core, ledgers, subjects) {
  const invalid = (message) => core.error('VALIDATION', message);

  function ledgerFor(store, name) {
    const entry = store.ledgers.get(name);
    if (entry === undefined) throw core.error('LEDGER_NOT_FOUND', `No ledger named ${name}`);
    const def = ledgers.refreshed(store, entry).definition;
    if (def.subjectField === undefined) throw invalid(`Ledger ${name} has no subject field`);
    if (isRetiredFormat(def)) throw core.error('LEDGER_FORMAT_RETIRED', LEDGER_FORMAT_RETIRED_MESSAGE);
    return entry;
  }

  function lookup(store, def, subjectId) {
    const canonicalId = canonicalSubjectId(subjectId, def.subjectCase, 'subjectId', invalid);
    const found = subjects.findSubject(store, def.name, canonicalId);
    if (found === undefined || found.state.state === 'absent') {
      throw core.error('SUBJECT_NOT_FOUND', 'This ledger holds no personal data for the data subject');
    }
    return found;
  }

  return { ledgerFor, lookup, invalid };
}

export function createShred(core, { ledgers, subjects, appends, signer }) {
  const { ledgerFor, lookup, invalid } = createSubjectLookup(core, ledgers, subjects);

  function parseShredRequest(body) {
    if (!isObject(body)) throw invalid('Body must be an object');
    const { subjectId, ...rest } = body;
    if (!isSubjectValue(subjectId)) throw invalid('subjectId is required (a string or a safe integer)');
    const extra = Object.keys(rest).find((k) => !FIELDS.includes(k));
    if (extra !== undefined) throw invalid(`Unknown field ${extra}`);
    const missing = FIELDS.find((f) => !isText(rest[f]));
    if (missing !== undefined) throw invalid(`${missing} is required (1 to ${MAX_SHRED_FIELD_CHARS} characters)`);
    return { subjectId, fields: { reason: rest.reason, authority: rest.authority, requestedBy: rest.requestedBy } };
  }

  // One shred entry per listed collection; none when the ledger is not ACTIVE (a DROPPED ledger takes no entries).
  function recordAll(store, entry, ref, fields) {
    if (entry.state !== 'ACTIVE') return [];
    const value = { $event: 'shred', subjectRef: ref, ...fields };
    return subjects.listingsOf(store, entry.definition.name, ref)
      .map((collection) => appends.appendShredEntry(store, entry, collection, value));
  }

  function receiptDocument(store, ledger, record, entries) {
    const head = { v: 2, type: RECEIPT_TYPE, id: record.id, org: core.org, store: store.id, ledger,
      subjectRef: record.subjectRef, refKeyVersion: record.refKeyVersion, shreddedAt: record.shreddedAt,
      fullyErasedAfter: record.fullyErasedAfter, reason: record.reason, authority: record.authority,
      requestedBy: record.requestedBy, entryCount: record.entryCount, entriesSha256: record.entriesSha256 };
    const full = { ...head, entries };
    return Buffer.byteLength(canonicalJson(full), 'utf8') <= MAX_RECEIPT_ENTRIES_BYTES ? full : head;
  }

  function signed(doc) {
    return { json: canonicalJson(doc), signature: signer.sign(doc), keyId: signer.keyId, algorithm: RECEIPT_ALGORITHM };
  }

  // The erasure record of this shred, with its sorted entries and its signed receipt, kept in store.shreds.
  function keepRecord(store, ledger, found, fields, done) {
    const entries = shredEntries(done.receipts);
    const fullyErasedAfter = new Date(Date.parse(done.shreddedAt) + PITR_DAYS * DAY_MS).toISOString();
    const record = { id: shredIdOf(done.shreddedAt, found.ref), subjectRef: found.ref, refKeyVersion: found.refKeyVersion,
      shreddedAt: done.shreddedAt, fullyErasedAfter, ...fields, entryCount: entries.length,
      entriesSha256: entriesSha256(entries), created_at: new Date(core.now()).toISOString() };
    const kept = { record, entries, receipt: signed(receiptDocument(store, ledger, record, entries)), receipts: done.receipts };
    store.shreds.set(`${ledger}#${record.id}`, kept);
    return kept;
  }

  const answer = (ledger, kept, already) => ({ ledger, subjectRef: kept.record.subjectRef,
    refKeyVersion: kept.record.refKeyVersion, shredId: kept.record.id, entries: already ? [] : kept.receipts,
    shreddedAt: kept.record.shreddedAt, fullyErasedAfter: kept.record.fullyErasedAfter, receipt: { ...kept.receipt },
    ...(already ? { alreadyShredded: true } : {}) });

  function shredLive(store, entry, found, fields) {
    const name = entry.definition.name;
    const receipts = recordAll(store, entry, found.ref, fields);
    const shreddedAt = subjects.tombstone(store, name, found.ref, (at) => shredIdOf(at, found.ref));
    return answer(name, keepRecord(store, name, found, fields, { receipts, shreddedAt }), false);
  }

  /** shred(storeId, ledger, body) -> the answer of the platform's 200. */
  function shred(storeId, name, body) {
    const store = core.needStore(storeId);
    const { subjectId, fields } = parseShredRequest(body);
    const entry = ledgerFor(store, name);
    const found = lookup(store, entry.definition, subjectId);
    if (found.state.state === 'live') return shredLive(store, entry, found, fields);
    const id = found.state.shredIds[found.state.shredIds.length - 1];
    return answer(name, store.shreds.get(`${name}#${id}`), true);
  }

  return { shred };
}
