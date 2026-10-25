// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// One page of a list or search. Options are already checked by the edge layer.
// Candidates: a collection (its ids in UTF-8 byte order, with startsWith/after/before as a range) or the keys of the
// store in UTF-8 byte order, narrowed by prefix. Each candidate read counts against the scan budget (budgetRows);
// filters (expiry, type, pattern, where) run on the rows read. A page ends at `limit` items, at the byte budget
// (one item at least), at the scan budget, or at the end. The cursor holds the last row read.
// A list on a ledger collection reads the entries in merge order (at, shard, id) within since/until; since and
// until need a ledger collection.
import { LIMITS } from '../../../lib/limits.mjs';
import { byteCompare, isPlainObject } from '../../../lib/check-util.mjs';
import { collectionOf, isLive } from './core.mjs';
import { bindingOf } from './cursor.mjs';
import { indexCandidates } from './indexes.mjs';
import { ledgerCandidates, ledgerListProblem } from './ledger-views.mjs';

const ENCRYPTED_TEXT = '[ENCRYPTED]';
const itemBytes = (item) => Buffer.byteLength(JSON.stringify(item));
const has = (o, name) => Object.hasOwn(o, name);

// A null cursor (the last page's cursor) and undefined values are absent.
const presentOptions = (options = {}) => Object.fromEntries(Object.entries(options)
  .filter(([name, value]) => value !== undefined && !(name === 'cursor' && value === null)));

function patternRegex(pattern) {
  const literal = pattern.split('*').map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  return new RegExp(`^${literal.join('[\\s\\S]*')}$`, 's');
}

// [option, (id) => true when the id is in range] for collection ranges.
const ID_RANGE = [
  ['startsWith', (id, o) => id.startsWith(o.startsWith)],
  ['after', (id, o) => byteCompare(id, o.after) > 0],
  ['before', (id, o) => byteCompare(id, o.before) < 0],
];

function collectionKeys(keys, o) {
  const tests = ID_RANGE.filter(([name]) => has(o, name)).map(([, test]) => test);
  const inCollection = (key) => collectionOf(key) === o.collection;
  const idOf = (key) => (o.collection === '' ? key : key.slice(o.collection.length + 1));
  return keys.filter((key) => inCollection(key) && tests.every((test) => test(idOf(key), o)));
}

/** Key-ordered candidates: { keys (in page order), positionOf, beyond }. The position is the key. */
function keyCandidates(store, o) {
  const all = [...store.items.keys()].sort(byteCompare);
  let keys = has(o, 'collection') ? collectionKeys(all, o) : all;
  if (has(o, 'prefix')) keys = keys.filter((key) => key.startsWith(o.prefix));
  const direction = o.reverse === true ? -1 : 1;
  if (direction < 0) keys.reverse();
  return { keys, positionOf: (key) => key, beyond: (key, position) => direction * byteCompare(key, position) > 0 };
}

const whereMatches = (value, where) => isPlainObject(value)
  && Object.entries(where).every(([field, want]) => has(value, field) && value[field] === want);

// [applies to the options, record passes] filters on a row read.
const FILTERS = [
  [(o) => o.type === 'plaintext', (row) => !row.record.encrypted],
  [(o) => o.type === 'encrypted', (row) => row.record.encrypted],
  [(o) => has(o, 'pattern'), (row, o) => patternRegex(o.pattern).test(row.key)],
  [(o) => has(o, 'where'), (row, o) => !row.record.encrypted && whereMatches(JSON.parse(row.record.raw), o.where)],
];

function plainItem(key, record, includeValues) {
  const item = { key, encrypted: record.encrypted, version: record.version, createdAt: record.createdAt,
    updatedAt: record.updatedAt };
  if (record.expiresAt !== null) item.expiresAt = record.expiresAt;
  if (includeValues === true) item.value = record.encrypted ? ENCRYPTED_TEXT : JSON.parse(record.raw);
  return item;
}

// The index of the first candidate after the cursor position (the position of the last row read).
function startIndex({ keys, beyond }, position) {
  if (position === null) return 0;
  const at = keys.findIndex((key) => beyond(key, position));
  return at < 0 ? keys.length : at;
}

export function createQuery(core, { budgetRows, cursors, indexes, ledgers, ledgerViews }) {
  const validation = (message) => core.error('VALIDATION', message);

  function ledgerListOf(store, o) {
    const problem = ledgerListProblem(o);
    if (problem !== null) throw validation(problem);
    return ledgerCandidates(store, o);
  }

  function candidatesOf(store, o) {
    if (has(o, 'index')) return indexCandidates(indexes, store, o);
    const ledgerList = has(o, 'collection') && ledgers.isLedgerCollection(store, o.collection);
    if (ledgerList) return ledgerListOf(store, o);
    if (has(o, 'since') || has(o, 'until')) throw validation('since and until need a ledger collection');
    return keyCandidates(store, o);
  }

  // Ledger entries open personal fields in a ledger list and a list by index only.
  function itemOf(store, key, record, o) {
    if (record.ledger === undefined) return plainItem(key, record, o.includeValues);
    const decrypt = has(o, 'collection') || has(o, 'index');
    return ledgerViews.item(store, key, record, { includeValues: o.includeValues, decrypt });
  }

  // The reason the page must stop before reading another row, or null.
  function stopBefore(page, limit) {
    if (page.items.length >= limit) return 'limit';
    return page.scanned >= budgetRows ? 'budget' : null;
  }

  // The item for a row, or null when the row is filtered out.
  function considered(store, key, o, filters) {
    const record = store.items.get(key);
    if (!isLive(record, core.now())) return null;
    const row = { key, record };
    return filters.every(([, passes]) => passes(row, o)) ? itemOf(store, key, record, o) : null;
  }

  function fill(store, keys, from, o) {
    const page = { items: [], bytes: 0, scanned: 0, last: null, next: from, end: 'end' };
    const limit = o.limit ?? LIMITS.listLimit.default;
    const filters = FILTERS.filter(([applies]) => applies(o));
    for (; page.next < keys.length; page.next += 1) {
      const stop = stopBefore(page, limit);
      if (stop !== null) return { ...page, end: stop };
      const item = considered(store, keys[page.next], o, filters);
      const size = item === null ? 0 : itemBytes(item);
      if (item !== null && page.items.length > 0 && page.bytes + size > LIMITS.pageBytesBudget) {
        return { ...page, end: 'bytes' };
      }
      page.scanned += 1;
      page.last = keys[page.next];
      if (item !== null) page.items.push(item);
      page.bytes += size;
    }
    return page;
  }

  function query(storeId, options, { search = false } = {}) {
    const store = core.needStore(storeId);
    const o = presentOptions(options);
    const binding = bindingOf(storeId, o, search ? 'search' : 'list');
    const position = has(o, 'cursor') ? cursors.open(o.cursor, binding) : null;
    const found = candidatesOf(store, o);
    const { keys } = found;
    const page = fill(store, keys, startIndex(found, position), o);
    const hasMore = page.next < keys.length;
    const last = page.last === null ? position : found.positionOf(page.last);
    const result = { items: page.items, cursor: hasMore ? cursors.issue(binding, last) : null, hasMore,
      scannedCount: page.scanned, pageEnd: hasMore ? page.end : 'end' };
    if (has(o, 'collection') || has(o, 'index')) result.indexed = true;
    return result;
  }

  return { query };
}
