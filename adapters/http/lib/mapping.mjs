// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Shape mapping between the public KV v2 API (public API spec 4.28.0) and the edge results of kvstore.d.ts.
//   API key read (KV_entries_show, KV_items_batch_get, KV_indexes_lookup) -> a backend record { key, raw, ... }
//     (lib/edge-calls.mjs turns it into the d.ts Entry): created_at/updated_at -> createdAt/updatedAt (ISO text as
//     given), expires_at (epoch seconds) -> expiresAt (epoch milliseconds), value -> raw (its JSON text).
//   KV_keys_list page -> QueryPage: data -> items, next_cursor -> cursor, has_more -> hasMore, page_end -> pageEnd.
//   KV_ledgers_status -> LedgerStatus: ledger.{name,state,collection,chains}, instances -> shards
//     (archiveLagSeconds -> lag), headSeq and archivedSeq summed, lag the maximum, next_cursor -> hasMoreShards.
//   KV_ledgers_create/show -> the v1 definition { v: 1, name, collection, chains, retentionDays, lockMode,
//     personalFields, subjectField?, subjectMode?, subjectCase?, anchor, writerPolicy?, createdAt }.
//   edge transaction ops -> KV_items_transact operations ({ op } -> { type }, set raw -> value).

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
const msOfSeconds = (seconds) => (typeof seconds === 'number' ? seconds * 1000 : undefined);

/** The metadata fields common to a key read and a list row. */
function metaOf(row) {
  return defined({
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: msOfSeconds(row.expires_at),
    version: row.version, ledger: row.ledger, personal: row.personal,
  });
}

/** A key read of the API as a backend record ({ key, raw, encrypted, ... }); null stays null. */
export function recordOf(row) {
  if (row === null || row === undefined) return null;
  return { key: row.key, raw: JSON.stringify(row.value ?? null), encrypted: row.encrypted === true, ...metaOf(row) };
}

function itemOf(row, includeValues) {
  const item = { key: row.key, encrypted: row.encrypted === true };
  if (includeValues && Object.hasOwn(row, 'value')) item.value = row.value;
  return { ...item, ...metaOf(row) };
}

export function pageOf(body, { includeValues = false } = {}) {
  return defined({
    items: (body.data ?? []).map((row) => itemOf(row, includeValues)),
    cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
    hasMore: body.has_more === true,
    pageEnd: body.page_end ?? undefined,
    indexed: body.indexed,
  });
}

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));

/** A range bound: a JSON scalar with index, the id text with collection. */
const boundOf = (value, options) => (value === undefined || options.index === undefined ? value : JSON.stringify(value));

/** The KV_keys_list query parameters of list/search options (one page). */
export function listQuery(options = {}) {
  return defined({
    limit: options.limit, cursor: options.cursor, include_values: options.includeValues, type: options.type,
    prefix: options.prefix, pattern: options.pattern, collection: options.collection, starts_with: options.startsWith,
    after: boundOf(options.after, options), before: boundOf(options.before, options), reverse: options.reverse,
    since: options.since, until: options.until, index: options.index, equals: json(options.equals), where: json(options.where),
  });
}

function shardOf(instance) {
  return defined({
    collection: instance.collection, shard: instance.shard, headSeq: instance.headSeq, archivedSeq: instance.archivedSeq,
    lag: instance.archiveLagSeconds, headAt: instance.headAt, broken: instance.broken,
  });
}

export function statusOf(body) {
  const ledger = body.ledger ?? {};
  const shards = (body.instances ?? []).map(shardOf);
  const sum = (field) => shards.reduce((total, s) => total + (s[field] ?? 0), 0);
  return defined({
    name: ledger.name, state: ledger.state, collection: ledger.collection, chains: ledger.chains,
    headSeq: sum('headSeq'), archivedSeq: sum('archivedSeq'), lag: Math.max(0, ...shards.map((s) => s.lag ?? 0)),
    shards, hasMoreShards: typeof body.next_cursor === 'string',
    activeAfter: ledger.state === 'PENDING' ? ledger.activeAfter : undefined,
    retainUntil: body.retainUntil, lastVerify: body.lastVerify,
  });
}

/** The v1 definition that definitionHash covers, rebuilt from a ledger of the API. */
export function definitionOf(ledger) {
  return defined({
    v: 1, name: ledger.name, collection: ledger.collection, chains: ledger.chains, retentionDays: ledger.retentionDays,
    lockMode: ledger.lockMode, personalFields: ledger.personalFields, subjectField: ledger.subjectField,
    subjectMode: ledger.subjectMode, subjectCase: ledger.subjectCase, anchor: ledger.anchor,
    writerPolicy: ledger.writerPolicy, createdAt: ledger.createdAt,
  });
}

const RECEIPT_FIELDS = ['key', 'id', 'shard', 'seq', 'at', 'hash', 'prevHash', 'ledger', 'source', 'replayed'];

export const receiptOf = (body) => defined(Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, body[name]])));

const OPERATIONS = {
  check: (op) => ({ type: 'check', key: op.key, version: op.version }),
  set: (op) => ({ type: 'set', key: op.key, value: JSON.parse(op.raw), ...op.options }),
  delete: (op) => ({ type: 'delete', key: op.key, ...op.options }),
  increment: (op) => ({ type: 'increment', key: op.key, amount: op.amount }),
};

/** The KV_items_transact operations of the checked edge ops (lib/edge-calls.mjs). */
export const operationsOf = (ops) => ops.map((op) => OPERATIONS[op.op](op));
