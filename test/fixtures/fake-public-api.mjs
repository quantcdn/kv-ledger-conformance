// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// A small fake of the public KV v2 API (public API spec 4.28.0) on node:http, for the HTTP adapter tests. It implements
// a handful of operations in memory: KV_create, KV_show, KV_delete, KV_entries_put/show/delete, KV_keys_list (with a
// cursor), KV_ledgers_create/show/status/public_key, and one route that echoes the Authorization header in an error
// (the adapter must redact it). Every request needs `Authorization: Bearer <token>`; each request is logged.
import { createServer } from 'node:http';
import { definitionHash } from '../../lib/ledger-bytes.mjs';

const PREFIX_RE = /^\/api\/v2\/organizations\/([^/]+)\/projects\/([^/]+)\/kv(.*)$/;
const PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfake\n-----END PUBLIC KEY-----\n';
const CREATED = '2026-10-25T00:00:00.000Z';

const fail = (status, code, message, extra = {}) => ({ status, body: { error: true, code, message, retryable: false, ...extra } });
const ok = (status, body, headers) => ({ status, body, headers });

function newVersion(state) {
  state.versions += 1;
  return `01KVC${String(state.versions).padStart(21, '0')}`;
}

function entryBody(key, item) {
  return { key, value: item.value, encrypted: false, created_at: CREATED, updated_at: CREATED, version: item.version };
}

function putEntry(state, store, key, body) {
  const current = store.items.get(key);
  if (body.ifVersion !== undefined && current?.version !== body.ifVersion) {
    return fail(409, 'CONFLICT', 'the version does not match', { key, reason: 'version', currentVersion: current?.version });
  }
  const item = { value: body.value, version: newVersion(state) };
  store.items.set(key, item);
  return ok(current ? 200 : 201, { ...entryBody(key, item), status: current ? 'updated' : 'created', message: 'ok' });
}

function listKeys(store, query) {
  const limit = Number(query.get('limit') ?? 25);
  const from = query.has('cursor') ? Number(query.get('cursor').slice(2)) : 0;
  const keys = [...store.items.keys()].filter((k) => k.startsWith(query.get('prefix') ?? '')).sort();
  const page = keys.slice(from, from + limit);
  const values = query.get('include_values') === 'true';
  const data = page.map((k) => {
    const row = entryBody(k, store.items.get(k));
    if (!values) delete row.value;
    return row;
  });
  const more = from + limit < keys.length;
  return ok(200, { data, next_cursor: more ? `c:${from + limit}` : null, has_more: more, page_end: more ? 'limit' : 'end' });
}

function ledgerBody(store, def) {
  const definition = { v: 1, name: def.name, collection: def.collection, chains: def.chains, retentionDays: def.retentionDays,
    lockMode: def.lockMode, personalFields: def.personalFields ?? [], anchor: def.anchor ?? { type: 'none' }, createdAt: CREATED };
  const { v, ...rest } = definition;
  return { ...rest, state: 'PENDING', activeAfter: new Date().toISOString(), definitionHash: definitionHash(definition) };
}

const STATUS_INSTANCES = [
  { collection: 'audit', shard: '00', headSeq: 3, headAt: 1792108800000, archivedSeq: 1, archiveLagSeconds: 40 },
  { collection: 'audit', shard: '01', headSeq: 2, archivedSeq: 2, archiveLagSeconds: 0 },
];

// [method, path pattern after /kv, handler(state, match, request)]; the first match answers.
const ROUTES = [
  ['POST', /^$/, (state, m, r) => {
    state.ids += 1;
    const id = `store${state.ids}`;
    state.stores.set(id, { name: r.body.name, format: r.body.format, items: new Map(), ledgers: new Map() });
    return ok(202, { id, name: r.body.name, status: 'provisioning' }, { 'retry-after': '0' });
  }],
  ['GET', /^\/([^/]+)$/, (state, m) => ok(200, { id: m[1], name: state.stores.get(m[1]).name, status: 'ready' })],
  ['DELETE', /^\/([^/]+)$/, (state, m) => {
    const store = state.stores.get(m[1]);
    if (store.ledgers.size > 0) return fail(409, 'LEDGER_PRESENT', 'the store has a ledger', { ledgers: [{ name: 'l', state: 'ACTIVE', reason: 'not_dropped' }] });
    state.stores.delete(m[1]);
    return ok(204, null);
  }],
  ['GET', /^\/([^/]+)\/items\/echo\/entry$/, (state, m, r) => fail(400, 'VALIDATION', `bad request from ${r.authorization}`)],
  ['PUT', /^\/([^/]+)\/items\/([^/]+)\/entry$/, (state, m, r) => putEntry(state, state.stores.get(m[1]), decodeURIComponent(m[2]), r.body)],
  ['GET', /^\/([^/]+)\/items\/([^/]+)\/entry$/, (state, m) => {
    const key = decodeURIComponent(m[2]);
    const item = state.stores.get(m[1]).items.get(key);
    return item ? ok(200, entryBody(key, item)) : fail(404, 'KEY_NOT_FOUND', 'no such key');
  }],
  ['DELETE', /^\/([^/]+)\/items\/([^/]+)\/entry$/, (state, m) => {
    const key = decodeURIComponent(m[2]);
    const had = state.stores.get(m[1]).items.delete(key);
    return had ? ok(200, { key, status: 'deleted', message: 'ok' }) : fail(404, 'KEY_NOT_FOUND', 'no such key');
  }],
  ['GET', /^\/([^/]+)\/keys$/, (state, m, r) => listKeys(state.stores.get(m[1]), r.query)],
  ['POST', /^\/([^/]+)\/ledgers$/, (state, m, r) => {
    const body = ledgerBody(state.stores.get(m[1]), r.body);
    state.stores.get(m[1]).ledgers.set(r.body.name, body);
    return ok(202, body);
  }],
  ['GET', /^\/([^/]+)\/ledgers\/public-key$/, () => ok(200, { keyId: 'k1', algorithm: 'ECDSA_SHA_256', curve: 'P-256', publicKeyPem: PEM })],
  ['GET', /^\/([^/]+)\/ledgers\/([^/]+)\/status$/, (state, m) => ok(200, {
    ledger: { ...state.stores.get(m[1]).ledgers.get(m[2]), state: 'ACTIVE' }, instances: STATUS_INSTANCES,
    anchor: { type: 'none' }, retainUntil: '2027-10-25T00:00:00.000Z', next_cursor: 'more',
  })],
  ['GET', /^\/([^/]+)\/ledgers\/([^/]+)$/, (state, m) => {
    state.ledgerPolls += 1;
    const ledger = state.stores.get(m[1]).ledgers.get(m[2]);
    return ok(200, { ...ledger, state: state.ledgerPolls >= 2 ? 'ACTIVE' : 'PENDING' });
  }],
];

function route(state, request) {
  const outer = PREFIX_RE.exec(request.path);
  if (outer === null || outer[1] !== state.org || outer[2] !== state.project) return fail(404, 'NOT_FOUND', 'no route');
  for (const [method, pattern, handler] of ROUTES) {
    const m = method === request.method ? pattern.exec(outer[3]) : null;
    if (m !== null) return handler(state, m, request);
  }
  return fail(404, 'NOT_FOUND', 'no route');
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function answer(res, { status, body, headers = {} }) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === null ? '' : JSON.stringify(body));
}

/** startFakeApi({ token, org, project }) -> { base, state, log, close() }. */
export async function startFakeApi({ token, org = 'o-1', project = 'p-1' }) {
  const state = { org, project, stores: new Map(), ids: 0, versions: 0, ledgerPolls: 0 };
  const log = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const request = { method: req.method, path: url.pathname, query: url.searchParams, body: await readJson(req),
      authorization: req.headers.authorization, contentType: req.headers['content-type'] };
    log.push(request);
    if (request.authorization !== `Bearer ${token}`) return answer(res, { status: 401, body: { error: true, message: 'Unauthenticated.' } });
    return answer(res, route(state, request));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, log, close: () => new Promise((r) => server.close(r)) };
}
