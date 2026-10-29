// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The entries of one data subject (the platform route POST …/ledgers/{name}/subject-entries; subject contract v1).
// A backend read, not part of the edge kvStore: subjectEntries(storeId, ledger, { subjectId, collection?, since?,
// until?, limit?, nextToken?, personal? }). It never writes and never makes a key.
// Live: the entries of the current key generation (found by its token), shred entries excluded, in the order of the
// platform: by key when an ACTIVE index on exactly [subjectField] covers a pseudonym ledger, else by collection, shard
// and id. Shredded: no entry; the ids of the subject's erasure records.
// The views are the platform's: { key, value, encrypted: false, created_at, updated_at, ledger } (personal 'decrypted',
// the default) or the sealed view with `personal` (personal 'sealed').
import { byteCompare } from '../../../lib/check-util.mjs';
import { LIMITS } from '../../../lib/limits.mjs';
import { ledgerBlock } from './ledger-views.mjs';
import { createSubjectLookup, isSubjectValue } from './subject-shred.mjs';
import { sealedValue, subjectModeOf, tokenOf } from './subject-value.mjs';

export const DEFAULT_SUBJECT_ENTRIES_LIMIT = 100;
export const MAX_SUBJECT_ENTRIES_LIMIT = 1000;
const FIELDS = new Set(['subjectId', 'collection', 'since', 'until', 'limit', 'nextToken', 'personal']);
const PERSONAL = ['decrypted', 'sealed'];
// The largest ULID time (48 bits).
const MAX_TIME = 2 ** 48 - 1;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLimit = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_SUBJECT_ENTRIES_LIMIT;
const optional = (name, v) => (v === undefined ? {} : { [name]: v });
const iso = (ms) => new Date(ms).toISOString();

function msOf(raw) {
  if (/^\d{1,15}$/.test(raw)) return Number(raw);
  return ISO_TIME.test(raw) ? Date.parse(raw) : NaN;
}

export function createSubjectEntries(core, { ledgers, subjects, ledgerViews, cursors, indexes }) {
  const { ledgerFor, lookup, invalid } = createSubjectLookup(core, ledgers, subjects);

  function timeOf(name, v) {
    if (v === undefined) return undefined;
    const ms = typeof v === 'string' || typeof v === 'number' ? msOf(String(v)) : NaN;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIME) throw invalid(`${name} must be epoch milliseconds or an ISO 8601 time`);
    return ms;
  }

  function collectionOf(v) {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '' || v.split(':').includes('*')) {
      throw invalid('collection must be a concrete collection of this ledger (no *)');
    }
    return v;
  }

  function checkShape(body) {
    if (!isObject(body)) throw invalid('Body must be an object');
    const extra = Object.keys(body).find((k) => !FIELDS.has(k));
    if (extra !== undefined) throw invalid(`Unknown field ${extra}`);
    if (!isSubjectValue(body.subjectId)) throw invalid('subjectId is required (a string or a safe integer)');
  }

  function scalarsOf(body) {
    const limit = body.limit ?? DEFAULT_SUBJECT_ENTRIES_LIMIT;
    const personal = body.personal ?? 'decrypted';
    if (!isLimit(limit)) throw invalid(`limit must be an integer from 1 to ${MAX_SUBJECT_ENTRIES_LIMIT}`);
    if (!PERSONAL.includes(personal)) throw invalid('personal must be decrypted or sealed');
    if (body.nextToken !== undefined && typeof body.nextToken !== 'string') throw invalid('nextToken must be a string');
    return { limit, personal, ...optional('nextToken', body.nextToken) };
  }

  function parseBody(body) {
    checkShape(body);
    const since = timeOf('since', body.since);
    const until = timeOf('until', body.until);
    if (since !== undefined && until !== undefined && until <= since) throw invalid('until must be after since');
    return { subjectId: body.subjectId, ...optional('collection', collectionOf(body.collection)),
      ...optional('since', since), ...optional('until', until), ...scalarsOf(body) };
  }

  function checkCollection(store, def, collection) {
    if (collection === undefined) return;
    if (ledgers.covering(store, collection)?.definition.name !== def.name) {
      throw invalid(`collection is not a collection of ledger ${def.name}`);
    }
  }

  // An ACTIVE index on exactly the subject field of a pseudonym ledger, covering the ledger: the platform reads it.
  function usesIndex(store, def) {
    if (subjectModeOf(def) !== 'pseudonym') return false;
    return [...store.indexes.values()].map((e) => indexes.refreshed(store, e)).some((e) => e.state === 'ACTIVE'
      && e.def.fields.length === 1 && e.def.fields[0] === def.subjectField && e.def.sortBy !== def.subjectField
      && patternCovers(e.def.collection, def.collection));
  }

  const patternCovers = (outer, inner) => {
    const [x, y] = [inner.split(':'), outer.split(':')];
    return x.length === y.length && y.every((segment, i) => segment === '*' || segment === x[i]);
  };

  const scanOrder = (a, b) => byteCompare(a.record.ledger.collection, b.record.ledger.collection)
    || byteCompare(a.record.ledger.shard, b.record.ledger.shard) || byteCompare(a.record.ledger.id, b.record.ledger.id);

  function inScope(req, collections, record) {
    const { collection, at } = record.ledger;
    return collections.includes(collection) && (req.since === undefined || at >= req.since)
      && (req.until === undefined || at < req.until);
  }

  // The rows of the subject's live generation, in page order.
  function rowsOf(store, entry, req, found) {
    const def = entry.definition;
    const collections = req.collection !== undefined ? [req.collection] : subjects.listingsOf(store, def.name, found.ref);
    const rows = [...store.items.entries()].map(([key, record]) => ({ key, record }))
      .filter(({ record }) => record.ledger?.name === def.name && inScope(req, collections, record))
      .filter(({ record }) => {
        const value = JSON.parse(record.raw);
        return value.$event === undefined && tokenOf(def, value) === found.state.token;
      });
    return rows.sort(usesIndex(store, def) ? (a, b) => byteCompare(a.key, b.key) : scanOrder);
  }

  function viewOf(store, def, req, { key, record }) {
    const head = { key, encrypted: false, created_at: iso(record.createdAt), updated_at: iso(record.updatedAt),
      ledger: ledgerBlock(record, def) };
    if (req.personal === 'decrypted') return { key, value: ledgerViews.openValue(store, key, record), ...head };
    const sealed = sealedValue(def, JSON.parse(record.raw));
    return { key, value: sealed.value, ...head, ...(sealed.personal.length ? { personal: sealed.personal } : {}) };
  }

  // The page: at most `limit` rows within the page byte budget (one at least), after the cursor's key.
  function pageOf(store, def, req, rows, binding) {
    const after = req.nextToken === undefined ? null : cursors.open(req.nextToken, binding);
    const start = after === null ? 0 : rows.findIndex((row) => row.key === after) + 1;
    const entries = [];
    let bytes = 0;
    for (const row of rows.slice(start, start + req.limit)) {
      const view = viewOf(store, def, req, row);
      bytes += Buffer.byteLength(JSON.stringify(view));
      if (entries.length > 0 && bytes > LIMITS.pageBytesBudget) break;
      entries.push(view);
    }
    const more = start + entries.length < rows.length;
    return { entries, ...optional('nextToken', more ? cursors.issue(binding, entries[entries.length - 1].key) : undefined) };
  }

  function shreddedAnswer(store, name, state) {
    const shreds = state.shredIds.filter((id) => store.shreds.has(`${name}#${id}`));
    return { ledger: name, subjectState: 'shredded', shreds, entries: [], complete: true,
      earlierGenerationsShredded: state.shredIds.length - 1 };
  }

  /** subjectEntries(storeId, ledger, body) -> the answer of the platform route. */
  function subjectEntries(storeId, name, body) {
    const store = core.needStore(storeId);
    const req = parseBody(body);
    const entry = ledgerFor(store, name);
    const def = entry.definition;
    checkCollection(store, def, req.collection);
    const found = lookup(store, def, req.subjectId);
    if (found.state.state === 'shredded') return shreddedAnswer(store, name, found.state);
    const binding = JSON.stringify(['subject-entries', storeId, name, found.ref, req.collection, req.since, req.until,
      req.personal]);
    const page = pageOf(store, def, req, rowsOf(store, entry, req, found), binding);
    return { ledger: name, subjectState: 'live', entries: page.entries, complete: true,
      ...optional('nextToken', page.nextToken), earlierGenerationsShredded: found.state.shredIds.length };
  }

  return { subjectEntries };
}
