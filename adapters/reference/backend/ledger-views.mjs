// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Reads of ledger entries (ledgers page "Append and Read", "Personal Fields and Shredding"; subject contract v1).
// A ledger record in store.items: { raw (the value as stored: personal fields sealed, and the subject token with the
// sealed $subject or $subjectTag), stored (the stored envelope string that is hashed), encrypted: false, createdAt,
// updatedAt (both `at`), expiresAt: null, personal (sealed field names), ledger: { name, collection, id, shard, seq,
// at, hash, prevHash, source } }.
// get, getEntry, getMany, a ledger list, a list by index and getBy open the sealed fields (subject-value.mjs); scan,
// prefix and pattern lists show '[PERSONAL]', leave $subject out and name the fields in `personal`. A field whose
// subject key is shredded reads { $shredded: true }. A ledger of the retired subject format refuses a decrypted read.
import { byteCompare } from '../../../lib/check-util.mjs';
import { timeMs } from '../../../lib/query-checks.mjs';
import { fieldAad } from './ledger-seal.mjs';
import {
  hasSealed, isRetiredFormat, LEDGER_FORMAT_RETIRED_MESSAGE, openedValue, openSealed, sealedValue, subjectModeOf, tokenOf,
} from './subject-value.mjs';

const has = (o, name) => Object.hasOwn(o, name);

/** The ledger block that reads show: no collection, no version; `subject` when the ledger has a subject field. */
export function ledgerBlock(record, def) {
  const { name, id, shard, seq, at, hash, prevHash, source } = record.ledger;
  const block = { name, id, shard, seq, at, hash, prevHash };
  if (source !== undefined) block.source = { ...source };
  const subject = def === undefined ? undefined : subjectModeOf(def);
  if (subject !== undefined) block.subject = subject;
  return block;
}

export function createLedgerViews(core, subjects) {
  const unavailable = (message, key) => core.error('UNAVAILABLE', message, { key, retryable: false });
  const definitionOf = (store, record) => store.ledgers.get(record.ledger.name)?.definition;

  // A sealed entry names its subject by a token; a token with no key row is lost key data: never guess.
  function keyOf(store, def, key, value) {
    const token = tokenOf(def, value);
    if (token === undefined) throw unavailable('A sealed ledger entry has no subject token', key);
    const keys = subjects.keysForRead(store, def.name, [token]);
    if (!keys.has(token)) throw unavailable('The subject key of a ledger entry is missing', key);
    return keys.get(token);
  }

  function opener(store, record, subjectKey) {
    const { collection, id } = record.ledger;
    return (sealed, field) => {
      try {
        return openSealed(sealed, subjectKey, fieldAad({ org: core.org, store: store.id, collection, id, field }));
      } catch {
        throw unavailable('A personal field of this ledger entry failed its integrity check', `${collection}:${id}`);
      }
    };
  }

  function openValue(store, key, record) {
    const def = definitionOf(store, record);
    if (isRetiredFormat(def)) throw core.error('LEDGER_FORMAT_RETIRED', LEDGER_FORMAT_RETIRED_MESSAGE);
    const value = JSON.parse(record.raw);
    if (!hasSealed(value, def)) return value;
    const subjectKey = keyOf(store, def, key, value);
    return openedValue(def, value, subjectKey, opener(store, record, subjectKey));
  }

  /** The read view of get/getEntry/getMany/getBy: { key, raw, encrypted, createdAt, updatedAt, ledger }. */
  function view(store, key, record) {
    return { key, raw: JSON.stringify(openValue(store, key, record)), encrypted: false, createdAt: record.createdAt,
      updatedAt: record.updatedAt, ledger: ledgerBlock(record, definitionOf(store, record)) };
  }

  /** A list item. decrypt: a ledger list or a list by index; otherwise personal fields are masked. */
  function item(store, key, record, { includeValues, decrypt }) {
    const def = definitionOf(store, record);
    const out = { key, encrypted: false, createdAt: record.createdAt, updatedAt: record.updatedAt,
      ledger: ledgerBlock(record, def) };
    if ((record.personal ?? []).length > 0) out.personal = [...record.personal];
    if (includeValues !== true) return out;
    out.value = decrypt ? openValue(store, key, record) : sealedValue(def, JSON.parse(record.raw)).value;
    return out;
  }

  return { view, item, openValue, definitionOf };
}

/** Merge order of a ledger list: at, then shard, then id. */
export const compareLinks = (a, b) => (a.at - b.at) || byteCompare(a.shard, b.shard) || byteCompare(a.id, b.id);

const inWindow = (at, o) => (!has(o, 'since') || at >= timeMs(o.since)) && (!has(o, 'until') || at < timeMs(o.until));

/** Candidates of a ledger list: the entries of the collection in the window, in merge order (or its reverse). */
export function ledgerCandidates(store, o) {
  const rows = [...store.items.entries()]
    .filter(([, record]) => record.ledger?.collection === o.collection && inWindow(record.ledger.at, o))
    .map(([key, record]) => ({ key, position: { at: record.ledger.at, shard: record.ledger.shard, id: record.ledger.id } }));
  const direction = o.reverse === true ? -1 : 1;
  rows.sort((a, b) => direction * compareLinks(a.position, b.position));
  const positions = new Map(rows.map((row) => [row.key, row.position]));
  return {
    keys: rows.map((row) => row.key),
    positionOf: (key) => positions.get(key),
    beyond: (key, position) => direction * compareLinks(positions.get(key), position) > 0,
  };
}

// Options a ledger list refuses (ledgers page): [problem, broken].
const LEDGER_LIST_RULES = [
  ['a ledger list does not take where, startsWith, after, before or index',
    (o) => ['where', 'startsWith', 'after', 'before', 'index', 'prefix', 'pattern'].some((name) => has(o, name))],
  ["a ledger list takes type 'all' or 'plaintext'", (o) => o.type === 'encrypted'],
];

/** The problem of a list on a ledger collection, or null. */
export function ledgerListProblem(o) {
  const rule = LEDGER_LIST_RULES.find(([, broken]) => broken(o));
  return rule === undefined ? null : rule[0];
}
