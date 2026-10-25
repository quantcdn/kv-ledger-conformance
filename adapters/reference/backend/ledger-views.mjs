// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Reads of ledger entries (ledgers page "Append and Read", "Personal Fields and Shredding").
// A ledger record in store.items: { raw (the value as stored, personal fields sealed), stored (the stored envelope
// string that is hashed), encrypted: false, createdAt, updatedAt (both `at`), expiresAt: null, personal (sealed
// field names), subjectKeyId, ledger: { name, collection, id, shard, seq, at, hash, prevHash, source } }.
// get, getEntry, getMany, a ledger list, a list by index and getBy open personal fields; scan, prefix and pattern
// lists show '[PERSONAL]' and name the fields in `personal`. A field whose subject key is gone reads as shredded.
import { byteCompare } from '../../../lib/check-util.mjs';
import { timeMs } from '../../../lib/query-checks.mjs';
import { fieldAad, openField } from './ledger-seal.mjs';

const PERSONAL_TEXT = '[PERSONAL]';
const SHREDDED = Object.freeze({ $shredded: true });
const has = (o, name) => Object.hasOwn(o, name);

/** The ledger block that reads show: no collection, no version. */
export function ledgerBlock(record) {
  const { name, id, shard, seq, at, hash, prevHash, source } = record.ledger;
  const block = { name, id, shard, seq, at, hash, prevHash };
  if (source !== undefined) block.source = { ...source };
  return block;
}

export function createLedgerViews(core) {
  function openValue(store, record) {
    const value = JSON.parse(record.raw);
    const keyText = store.subjectKeys.get(record.subjectKeyId);
    const { collection, id } = record.ledger;
    for (const field of record.personal ?? []) {
      if (keyText === undefined) {
        value[field] = { ...SHREDDED };
        continue;
      }
      const aad = fieldAad({ org: core.org, store: store.id, collection, id, field });
      value[field] = JSON.parse(openField({ key: Buffer.from(keyText, 'base64'), aad, envelope: value[field] }));
    }
    return value;
  }

  function maskedValue(record) {
    const value = JSON.parse(record.raw);
    for (const field of record.personal ?? []) value[field] = PERSONAL_TEXT;
    return value;
  }

  /** The read view of get/getEntry/getMany/getBy: { key, raw, encrypted, createdAt, updatedAt, ledger }. */
  function view(store, key, record) {
    return { key, raw: JSON.stringify(openValue(store, record)), encrypted: false, createdAt: record.createdAt,
      updatedAt: record.updatedAt, ledger: ledgerBlock(record) };
  }

  /** A list item. decrypt: a ledger list or a list by index; otherwise personal fields are masked. */
  function item(store, key, record, { includeValues, decrypt }) {
    const out = { key, encrypted: false, createdAt: record.createdAt, updatedAt: record.updatedAt,
      ledger: ledgerBlock(record) };
    if ((record.personal ?? []).length > 0) out.personal = [...record.personal];
    if (includeValues === true) out.value = decrypt ? openValue(store, record) : maskedValue(record);
    return out;
  }

  return { view, item };
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
