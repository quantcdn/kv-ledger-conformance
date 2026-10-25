// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The public API adapter (spec 10.2) against a small fake of the public KV v2 API (test/fixtures/fake-public-api.mjs):
// request methods, paths, bodies and the bearer token; shape mapping to the edge results; error mapping; the rate
// cap; the token absent from errors, adapter properties and reports; the env check; the edge-harness default admin.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as http from '../adapters/http/index.mjs';
import { createPublicApi } from '../adapters/http/lib/public-api.mjs';
import * as edge from '../adapters/edge-harness/index.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { definitionHash } from '../lib/ledger-bytes.mjs';
import { run } from '../lib/runner.mjs';
import { startFakeApi } from './fixtures/fake-public-api.mjs';

const TOKEN = `kvc-api-${randomBytes(16).toString('hex')}`;
const KV_PATH = '/api/v2/organizations/o-1/projects/p-1/kv';
let api;

before(async () => {
  api = await startFakeApi({ token: TOKEN });
});
after(() => api.close());

const envOf = (over = {}) => ({
  KVC_API_BASE: api.base, KVC_ORG: 'o-1', KVC_PROJECT: 'p-1', KVC_API_TOKEN: TOKEN, KVC_RATE: '1000', ...over,
});
const makeAdapter = (over = {}) => http.createAdapter({ env: envOf(), pollMs: 1, log: () => {}, ...over });
const since = (mark) => api.log.slice(mark);

// Every string reachable from a value (own properties, any depth), functions excluded.
function strings(value, seen = new Set()) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Reflect.ownKeys(value).flatMap((k) => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    return [String(k), ...('value' in d ? strings(d.value, seen) : [])];
  });
}

const errorText = (e) => [e.message, e.stack, JSON.stringify(e), String(e.cause?.message), ...strings(e)].join('\n');

test('createAdapter: name, shapes, real clock, capabilities and no control hooks', async () => {
  const adapter = await makeAdapter();
  assert.equal(adapter.name, 'http');
  assert.deepEqual(adapter.shapes, ['global', 'handle']);
  assert.equal(adapter.clock.virtual, false);
  assert.ok(adapter.defaultTimeoutMs >= 60000, 'a realistic default case timeout for the rate cap');
  assert.deepEqual(adapter.capabilities, {
    virtualClock: false, eventualIndexLists: true, indexBuildStates: true, proofTiming: true, signedProofs: true,
    search: true, secretEncryption: false, subjectV1: false, setClock: false, advanceArchive: false, injectFault: false,
  });
  assert.equal(adapter.control, undefined);
  assert.equal(typeof adapter.kvStore.KVError, 'function');
});

test('createStore: KV_create with format 2 and a kvc- name, then KV_show until ready; identity is org and name', async () => {
  const adapter = await makeAdapter();
  const mark = api.log.length;
  const { storeId, identity } = await adapter.admin.createStore({ format: 2 });
  const [create, show] = since(mark);
  assert.equal(create.method, 'POST');
  assert.equal(create.path, KV_PATH);
  assert.equal(create.body.format, 2);
  assert.match(create.body.name, /^kvc-[a-z0-9-]+$/);
  assert.equal(create.contentType, 'application/json');
  assert.equal(create.authorization, `Bearer ${TOKEN}`);
  assert.equal(show.method, 'GET');
  assert.equal(show.path, `${KV_PATH}/${storeId}`);
  assert.deepEqual(identity, { org: 'o-1', store: create.body.name });
  const second = await adapter.admin.createStore({ format: 2 });
  assert.notEqual(second.storeId, storeId);
  assert.notEqual(second.identity.store, identity.store);
});

test('set, get, getEntry and delete map to KV_entries_put, KV_entries_show and KV_entries_delete', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  const kv = adapter.kvStore;
  const mark = api.log.length;
  assert.equal(await kv.set(storeId, 'user:1', { a: 1 }, { ttl: 600 }), true);
  const [put] = since(mark);
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, `${KV_PATH}/${storeId}/items/user%3A1/entry`);
  assert.deepEqual(put.body, { value: { a: 1 }, ttl: 600 });
  assert.deepEqual(await kv.get(storeId, 'user:1'), { a: 1 });
  assert.equal(await kv.get(storeId, 'user:1', true), '{"a":1}');
  const entry = await kv.getEntry(storeId, 'user:1');
  assert.deepEqual(entry.value, { a: 1 });
  assert.equal(entry.key, 'user:1');
  assert.match(entry.version, /^[0-9A-Z]{26}$/);
  assert.equal(entry.encrypted, false);
  assert.equal(entry.createdAt, '2026-10-25T00:00:00.000Z');
  const conditional = await kv.set(storeId, 'user:1', { a: 2 }, { ifVersion: entry.version });
  assert.match(conditional.version, /^[0-9A-Z]{26}$/);
  const del = api.log.length;
  assert.equal(await kv.delete(storeId, 'user:1'), true);
  assert.equal(since(del)[0].method, 'DELETE');
  assert.equal(await kv.get(storeId, 'user:1'), null);
  assert.equal(await kv.getEntry(storeId, 'user:1'), null);
  assert.equal(await kv.delete(storeId, 'user:1'), true, 'a missing key deletes as true, as at the edge');
  assert.equal(await kv.open(storeId).get('nothing'), null);
});

test('list follows next_cursor page by page with the documented query parameters', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  for (const n of [1, 2, 3, 4, 5]) await adapter.kvStore.set(storeId, `p:${n}`, n);
  const mark = api.log.length;
  const pages = [];
  for await (const page of adapter.kvStore.list(storeId, { prefix: 'p:', limit: 2, includeValues: true }).pages()) pages.push(page);
  assert.deepEqual(pages.map((p) => p.items.map((i) => i.key)), [['p:1', 'p:2'], ['p:3', 'p:4'], ['p:5']]);
  assert.deepEqual(pages.map((p) => p.hasMore), [true, true, false]);
  assert.deepEqual(pages.map((p) => p.pageEnd), ['limit', 'limit', 'end']);
  assert.equal(pages[2].cursor, null);
  assert.equal(pages[0].items[0].value, 1);
  assert.equal(pages[0].items[0].encrypted, false);
  const requests = since(mark);
  assert.deepEqual(requests.map((r) => r.query.get('cursor')), [null, 'c:2', 'c:4']);
  for (const r of requests) {
    assert.equal(r.path, `${KV_PATH}/${storeId}/keys`);
    assert.equal(r.query.get('prefix'), 'p:');
    assert.equal(r.query.get('limit'), '2');
    assert.equal(r.query.get('include_values'), 'true');
  }
  const keysOnly = await adapter.kvStore.list(storeId, { prefix: 'p:' });
  assert.ok(!('value' in keysOnly.items[0]), 'no value without includeValues');
});

test('an error body maps to the adapter KVError with code, status, retryable and the scalar details', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  await adapter.kvStore.set(storeId, 'k', 1);
  const err = await adapter.kvStore.set(storeId, 'k', 2, { ifVersion: '01KVC000000000000000000000' }).catch((e) => e);
  assert.ok(err instanceof adapter.kvStore.KVError);
  assert.equal(err.name, 'KVError');
  assert.equal(err.code, 'CONFLICT');
  assert.equal(err.status, 409);
  assert.equal(err.retryable, false);
  assert.equal(err.reason, 'version');
  assert.equal(err.key, 'k');
  assert.match(err.currentVersion, /^[0-9A-Z]{26}$/);
});

test('store ids not created by the adapter are FORBIDDEN (403) without a request; edge checks run first', async () => {
  const adapter = await makeAdapter();
  const mark = api.log.length;
  await assert.rejects(adapter.kvStore.get('store999', 'k'), (e) => e instanceof adapter.kvStore.KVError && e.code === 'FORBIDDEN' && e.status === 403);
  await assert.rejects(adapter.kvStore.get('bad id!', 'k'), (e) => e.code === 'VALIDATION' && e.status === undefined);
  const { storeId } = await adapter.admin.createStore();
  const created = api.log.length;
  await assert.rejects(adapter.kvStore.set(storeId, 'k', 1, { ttl: 5 }), (e) => e.code === 'VALIDATION');
  await assert.rejects(adapter.kvStore.getMany(storeId, []), (e) => e.code === 'VALIDATION');
  assert.equal(api.log.length, created, 'no request for an edge-checked call');
  assert.equal(created - mark, 2, 'only the create and the readiness poll were sent');
});

test('declareLedger polls KV_ledgers_show until ACTIVE and returns the v1 definition and its hash', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  api.state.ledgerPolls = 0;
  const mark = api.log.length;
  const declared = await adapter.admin.declareLedger(storeId, { name: 'audit', collection: 'audit', chains: 2, retentionDays: 1 });
  const [create, ...polls] = since(mark);
  assert.equal(create.method, 'POST');
  assert.equal(create.path, `${KV_PATH}/${storeId}/ledgers`);
  assert.deepEqual(create.body, { name: 'audit', collection: 'audit', chains: 2, retentionDays: 1, lockMode: 'governance' });
  assert.ok(polls.length >= 2);
  assert.ok(polls.every((p) => p.path === `${KV_PATH}/${storeId}/ledgers/audit`));
  assert.equal(declared.state, 'ACTIVE');
  assert.equal(declared.name, 'audit');
  assert.equal(declared.definition.v, 1);
  assert.equal(declared.definitionHash, definitionHash(declared.definition));
  assert.equal(typeof declared.activeAfter, 'string');
  assert.match(await adapter.admin.proofPublicKey(storeId), /BEGIN PUBLIC KEY/);
});

test('ledgerStatus maps KV_ledgers_status to the edge LedgerStatus shape', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  await adapter.admin.declareLedger(storeId, { name: 'audit', collection: 'audit', chains: 2, retentionDays: 1 });
  const status = await adapter.kvStore.ledgerStatus(storeId, 'audit');
  assert.deepEqual(status, {
    name: 'audit', state: 'ACTIVE', collection: 'audit', chains: 2, headSeq: 5, archivedSeq: 3, lag: 40,
    shards: [
      { collection: 'audit', shard: '00', headSeq: 3, archivedSeq: 1, lag: 40, headAt: 1792108800000 },
      { collection: 'audit', shard: '01', headSeq: 2, archivedSeq: 2, lag: 0 },
    ],
    hasMoreShards: true, retainUntil: '2027-10-25T00:00:00.000Z',
  });
});

test('dispose deletes the stores it created and names the ones it could not delete, without failing', async () => {
  const lines = [];
  const adapter = await makeAdapter({ log: (line) => lines.push(line) });
  const plain = await adapter.admin.createStore();
  const withLedger = await adapter.admin.createStore();
  await adapter.admin.declareLedger(withLedger.storeId, { name: 'audit', collection: 'audit', chains: 1, retentionDays: 1 });
  const mark = api.log.length;
  const summary = await adapter.admin.dispose();
  const deletes = since(mark).filter((r) => r.method === 'DELETE');
  assert.deepEqual(deletes.map((r) => r.query.get('force')), ['true', 'true']);
  assert.ok(!api.state.stores.has(plain.storeId));
  assert.deepEqual(summary.deleted, [plain.identity.store]);
  assert.deepEqual(summary.kept, [{ store: withLedger.identity.store, code: 'LEDGER_PRESENT' }]);
  assert.ok(lines.some((line) => line.includes(withLedger.identity.store)));
  await assert.rejects(adapter.kvStore.get(plain.storeId, 'k'), (e) => e.code === 'FORBIDDEN');
});

const fakeResponse = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });

test('public API errors: documented body, else 5xx and 429 UNAVAILABLE retryable, 404 NOT_FOUND, other 4xx VALIDATION', async () => {
  const KVError = createKVErrorClass();
  const answers = [
    [503, { error: true, code: 'STORE_MIGRATING', message: 'm', retryable: true, state: 'x' }, { code: 'STORE_MIGRATING', retryable: true, status: 503, state: 'x' }],
    [500, { error: true, message: 'oops' }, { code: 'UNAVAILABLE', retryable: true, status: 500 }],
    [429, undefined, { code: 'UNAVAILABLE', retryable: true, status: 429 }],
    [404, { error: true, message: 'gone' }, { code: 'NOT_FOUND', retryable: false, status: 404 }],
    [400, { error: true, message: 'bad' }, { code: 'VALIDATION', retryable: false, status: 400 }],
    [401, { error: true, message: 'Unauthenticated.' }, { code: 'VALIDATION', retryable: false, status: 401 }],
  ];
  for (const [status, body, want] of answers) {
    const client = createPublicApi({ base: 'http://api.test', org: 'o', project: 'p', token: TOKEN, rate: 1000, KVError,
      fetch: async () => fakeResponse(status, body, status === 429 ? { 'retry-after': '7' } : {}) });
    const err = await client.request('GET', '/x').catch((e) => e);
    assert.ok(err instanceof KVError, `status ${status}`);
    for (const [name, value] of Object.entries(want)) assert.equal(err[name], value, `${status} ${name}`);
    if (status === 429) assert.equal(err.retryAfter, 7);
  }
  const notJson = createPublicApi({ base: 'http://api.test', org: 'o', project: 'p', token: TOKEN, rate: 1000, KVError,
    fetch: async () => new Response('<html>', { status: 200 }) });
  await assert.rejects(notJson.request('GET', '/x'), (e) => e instanceof KVError && e.code === 'RESPONSE_INVALID');
});

test('public API: the request carries the bearer token only in the Authorization header; the path is under the org and project', async () => {
  const seen = [];
  const client = createPublicApi({ base: 'http://api.test/', org: 'my org', project: 'p/1', token: TOKEN, rate: 1000,
    KVError: createKVErrorClass(), fetch: async (url, init) => { seen.push({ url, init }); return fakeResponse(200, { ok: 1 }); } });
  const out = await client.request('POST', '/s1/append', { body: { a: 1 }, query: { x: 'y z', skip: undefined } });
  assert.deepEqual(out.body, { ok: 1 });
  assert.equal(out.status, 200);
  const [{ url, init }] = seen;
  assert.equal(url, 'http://api.test/api/v2/organizations/my%20org/projects/p%2F1/kv/s1/append?x=y+z');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.body, '{"a":1}');
  assert.ok(!url.includes(TOKEN) && !init.body.includes(TOKEN));
  assert.ok(!strings(client).some((s) => s.includes(TOKEN)), 'the client object does not hold the token');
});

test('rate cap: a token bucket of rate requests per second with a burst of rate', async () => {
  let calls = 0;
  const client = createPublicApi({ base: 'http://api.test', org: 'o', project: 'p', token: TOKEN, rate: 10,
    KVError: createKVErrorClass(), fetch: async () => { calls += 1; return fakeResponse(200, {}); } });
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) await client.request('GET', '/x');
  const elapsed = Date.now() - started;
  assert.equal(calls, 20);
  assert.ok(elapsed >= 900, `20 calls at 10/s with a burst of 10 take about 1 s (took ${elapsed} ms)`);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});

test('the token is absent from thrown errors, adapter properties and a report', async () => {
  const adapter = await makeAdapter();
  const { storeId } = await adapter.admin.createStore();
  const echoed = await adapter.kvStore.get(storeId, 'echo').catch((e) => e);
  assert.equal(echoed.code, 'VALIDATION');
  assert.match(echoed.message, /\[redacted\]/);
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadBase = `http://127.0.0.1:${dead.address().port}`;
  await new Promise((resolve) => dead.close(resolve));
  const offline = await http.createAdapter({ env: envOf({ KVC_API_BASE: deadBase }), log: () => {} });
  const transport = await offline.admin.createStore().catch((e) => e);
  assert.equal(transport.code, 'UNAVAILABLE');
  const wrong = await http.createAdapter({ env: envOf({ KVC_API_TOKEN: `${TOKEN}-other` }), log: () => {} });
  const refused = await wrong.admin.createStore().catch((e) => e);
  assert.equal(refused.status, 401);
  for (const e of [echoed, transport, refused]) assert.ok(!errorText(e).includes(TOKEN), `token in: ${e.message}`);
  assert.ok(!strings(adapter).some((s) => s.includes(TOKEN)), 'no adapter property holds the token');
  const cases = [
    { name: 'core/http/set-get', tags: ['core'], needs: [], run: async (ctx) => {
      await ctx.kv.set('k', { n: 1 });
      assert.deepEqual(await ctx.kv.get('k'), { n: 1 });
    } },
    { name: 'core/http/error', tags: ['core'], needs: [], run: async (ctx) => { await ctx.kv.get('echo'); } },
  ];
  const report = await run({ adapter: { createAdapter: (o) => makeAdapter(o) }, cases });
  assert.equal(report.adapter, 'http');
  assert.deepEqual(report.results.map((r) => r.status), ['pass', 'pass', 'fail', 'fail']);
  assert.ok(!JSON.stringify(report).includes(TOKEN));
});

test('createAdapter names the missing variables, never a value', async () => {
  const secret = `value-${randomBytes(8).toString('hex')}`;
  const err = await http.createAdapter({ env: { KVC_API_TOKEN: secret, KVC_ORG: '' } }).catch((e) => e);
  assert.ok(err instanceof Error);
  for (const name of ['KVC_API_BASE', 'KVC_ORG', 'KVC_PROJECT']) assert.match(err.message, new RegExp(name));
  assert.doesNotMatch(err.message, /KVC_API_TOKEN/);
  assert.ok(!errorText(err).includes(secret));
  const badRate = await http.createAdapter({ env: envOf({ KVC_RATE: 'fast' }) }).catch((e) => e);
  assert.match(badRate.message, /KVC_RATE/);
  const badBase = await http.createAdapter({ env: envOf({ KVC_API_BASE: `ftp://${secret}` }) }).catch((e) => e);
  assert.match(badBase.message, /KVC_API_BASE/);
  assert.ok(!badBase.message.includes(secret));
});

// A stand-in for the deployed harness function: it answers only the open() probe of the edge-harness adapter.
async function probeOnlyHarness() {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { ok: false, error: { name: 'KVError', code: 'VALIDATION', retryable: false, instanceOfKVError: true, message: 'storeId must be a string' } },
      { ok: true, value: { frozen: true } },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

test('edge-harness createAdapter without an admin builds the public API admin from env', async () => {
  const harness = await probeOnlyHarness();
  try {
    const env = { ...envOf(), KVC_HARNESS_URL: harness.url, KVC_HARNESS_TOKEN: `${TOKEN}-harness` };
    const adapter = await edge.createAdapter({ env });
    const mark = api.log.length;
    const { storeId, identity } = await adapter.admin.createStore({ format: 2 });
    assert.equal(identity.org, 'o-1');
    assert.equal(since(mark)[0].path, KV_PATH);
    assert.ok(api.state.stores.has(storeId));
    await adapter.admin.dispose();
    assert.ok(!api.state.stores.has(storeId));
  } finally {
    await harness.close();
  }
});
