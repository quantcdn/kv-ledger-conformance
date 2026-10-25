// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The store-level backend of the HTTP adapter: the methods lib/edge-calls.mjs calls with checked arguments, each one
// request to the public KV v2 API (operationIds of public API spec 4.28.0, spec 10.2):
//   get (also getEntry)  KV_entries_show      404 KEY_NOT_FOUND -> null
//   put                  KV_entries_put       -> { version }
//   remove               KV_entries_delete    404 KEY_NOT_FOUND without ifVersion -> true (the edge delete is idempotent)
//   increment            KV_items_increment   -> the value
//   batchGet             KV_items_batch_get   -> records or null, in input order
//   transact             KV_items_transact    -> { versions, replayed }
//   query (list/search)  KV_keys_list         one page
//   lookup (getBy)       KV_indexes_lookup    404 KEY_NOT_FOUND -> null
//   count                KV_indexes_count     -> the count
//   append               KV_ledgers_append    -> the receipt (the edge's automatic key is sent as idempotencyKey)
//   ledgerStatus         KV_ledgers_status    first page of instances -> LedgerStatus
//   ledgerProof          KV_ledgers_proof     the body unchanged
// `stores` is the adapter's Map storeId -> { name, format } (the allow-list); storeFormat reads it.
import {
  listQuery, operationsOf, pageOf, receiptOf, recordOf, statusOf,
} from './mapping.mjs';

const enc = encodeURIComponent;

/** Resolves to fallback when the call fails with one of the codes; other errors pass. */
async function orWhen(promise, codes, fallback) {
  try {
    return await promise;
  } catch (err) {
    if (codes.includes(err?.code)) return fallback;
    throw err;
  }
}

export function createApiBackend({ api, stores }) {
  const store = (storeId) => `/${enc(storeId)}`;
  const entry = (storeId, key) => `${store(storeId)}/items/${enc(key)}/entry`;
  const ledger = (storeId, name) => `${store(storeId)}/ledgers/${enc(name)}`;
  const body = async (promise) => (await promise).body;

  return {
    storeFormat: (storeId) => stores.get(storeId)?.format ?? 2,

    get: (storeId, key) => orWhen(body(api.request('GET', entry(storeId, key))).then(recordOf), ['KEY_NOT_FOUND'], null),

    async put(storeId, key, raw, options) {
      const answer = await body(api.request('PUT', entry(storeId, key), { body: { value: JSON.parse(raw), ...options } }));
      return { version: answer?.version };
    },

    async remove(storeId, key, options) {
      const query = { if_version: options.ifVersion };
      const sent = api.request('DELETE', entry(storeId, key), { query }).then(() => true);
      return options.ifVersion === undefined ? orWhen(sent, ['KEY_NOT_FOUND'], true) : sent;
    },

    async increment(storeId, key, amount, options) {
      const path = `${store(storeId)}/items/${enc(key)}/increment`;
      return (await body(api.request('POST', path, { body: { amount, ...options } }))).value;
    },

    async batchGet(storeId, keys) {
      const answer = await body(api.request('POST', `${store(storeId)}/batch-get`, { body: { keys } }));
      return answer.items.map(recordOf);
    },

    async transact(storeId, ops, options) {
      const request = { operations: operationsOf(ops), ...options };
      const answer = await body(api.request('POST', `${store(storeId)}/transact`, { body: request }));
      return { versions: answer?.versions ?? {}, replayed: answer?.replayed === true };
    },

    async query(storeId, options) {
      const answer = await body(api.request('GET', `${store(storeId)}/keys`, { query: listQuery(options) }));
      return pageOf(answer, { includeValues: options.includeValues === true });
    },

    lookup(storeId, index, equals) {
      const path = `${store(storeId)}/indexes/${enc(index)}/lookup`;
      return orWhen(body(api.request('GET', path, { query: { equals: JSON.stringify(equals) } })).then(recordOf), ['KEY_NOT_FOUND'], null);
    },

    async count(storeId, { index, equals }) {
      const query = { equals: equals === undefined ? undefined : JSON.stringify(equals) };
      return (await body(api.request('GET', `${store(storeId)}/indexes/${enc(index)}/count`, { query }))).count;
    },

    async append(storeId, collection, value, { idempotencyKey }) {
      const request = { collection, value, idempotencyKey };
      return receiptOf(await body(api.request('POST', `${store(storeId)}/append`, { body: request })));
    },

    async ledgerStatus(storeId, name) {
      return statusOf(await body(api.request('GET', `${ledger(storeId, name)}/status`)));
    },

    ledgerProof: (storeId, name, key) => body(api.request('GET', `${ledger(storeId, name)}/proof`, { query: { key } })),
  };
}
