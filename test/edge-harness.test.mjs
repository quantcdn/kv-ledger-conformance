// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The edge harness: harness-fn.js runs in Node as an async function body behind a local node:http server, over the
// reference adapter's kvStore; the edge-harness adapter (the proxy) runs the default suite through it.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { run } from '../lib/runner.mjs';
import { createRealClock } from '../lib/clock.mjs';
import * as reference from '../adapters/reference/index.mjs';
import * as edge from '../adapters/edge-harness/index.mjs';
import { buildProxyKvStore } from '../adapters/edge-harness/proxy.mjs';
import { rebuildError } from '../adapters/edge-harness/client.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';

const AsyncFunction = (async () => {}).constructor;
const SOURCE = readFileSync(new URL('../adapters/edge-harness/harness-fn.js', import.meta.url), 'utf8');
const TOKEN = `kvc-test-${randomBytes(16).toString('hex')}`;

// The function body as the runtime wraps it; token undefined keeps the placeholder.
function harnessFn(token) {
  const body = token === undefined ? SOURCE : SOURCE.replaceAll('__HARNESS_TOKEN__', token);
  return new AsyncFunction('event', 'kvStore', `'use strict';\n${body}`);
}

// A kvStore view that counts every method read (a call needs a read first).
function spy(kvStore) {
  const log = { reads: 0 };
  const view = new Proxy(kvStore, {
    get(target, prop, receiver) {
      if (prop !== 'KVError' && typeof target[prop] === 'function') log.reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { view, log };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function serve(fn, kvStore) {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const init = { method: req.method, headers: { 'content-type': String(req.headers['content-type'] || '') } };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = body;
    const response = await fn({ request: new Request(`http://127.0.0.1${req.url}`, init) }, kvStore);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain' });
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

const post = async (url, body, method = 'POST') => {
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (method === 'POST') init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  return { status: res.status, json: await res.json() };
};

let ref;
let main;
let counted;
let countedServer;

before(async () => {
  ref = await reference.createAdapter({ clock: createRealClock() });
  main = await serve(harnessFn(TOKEN), ref.kvStore);
  counted = spy(ref.kvStore);
  countedServer = await serve(harnessFn(TOKEN), counted.view);
});

after(async () => {
  await main.close();
  await countedServer.close();
});

const call = (over = {}) => ({ shape: 'global', storeId: 'kvc-1', method: 'get', args: ['k'], ...over });

test('harness-fn.js: SPDX lines first, only web globals', () => {
  const lines = SOURCE.split('\n');
  assert.equal(lines[0], '// SPDX-License-Identifier: Apache-2.0');
  assert.equal(lines[1], '// Copyright 2026 QuantCDN Pty Ltd');
  const code = lines.filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const word of ['require(', 'process.', 'Buffer', 'import ', 'node:', 'crypto']) {
    assert.ok(!code.includes(word), `no ${word} in the function body`);
  }
});

test('the placeholder token answers 503 and calls nothing', async () => {
  const { view, log } = spy(ref.kvStore);
  const server = await serve(harnessFn(undefined), view);
  try {
    const res = await post(server.url, { token: '__HARNESS_TOKEN__', calls: [call()] });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /not configured/);
    assert.equal(log.reads, 0);
  } finally {
    await server.close();
  }
});

test('a missing or wrong token answers 403 and calls nothing', async () => {
  const before0 = counted.log.reads;
  for (const token of [undefined, '', 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1), 42]) {
    const res = await post(countedServer.url, { token, calls: [call()] });
    assert.equal(res.status, 403, `token ${String(token)}`);
    assert.ok(!JSON.stringify(res.json).includes(TOKEN));
  }
  const bad = await fetch(countedServer.url, { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 403);
  assert.equal(counted.log.reads, before0);
});

test('not POST answers 405', async () => {
  assert.equal((await post(main.url, null, 'GET')).status, 405);
});

test('a bad call answers 400 and calls nothing', async () => {
  const before0 = counted.log.reads;
  const bad = [
    [call({ method: 'constructor' })],
    [call({ method: 'eval' })],
    [call({ method: 'open', shape: 'handle' })],
    [call({ shape: 'other' })],
    [call({ args: 'k' })],
    [call({ method: 'get', iterate: { mode: 'items' } })],
    [call({ method: 'list', iterate: { mode: 'bogus' } })],
    [call({ method: 'atomic', ops: [{ op: 'eval', args: [] }], commit: [{}] })],
    [call({ method: 'atomic', ops: [], commit: [] })],
    [call(), 'x'],
    [],
    Array.from({ length: 51 }, () => call()),
  ];
  for (const calls of bad) {
    const res = await post(countedServer.url, { token: TOKEN, calls });
    assert.equal(res.status, 400, JSON.stringify(calls).slice(0, 120));
    assert.equal(typeof res.json.error, 'string');
  }
  assert.equal(counted.log.reads, before0);
  const fifty = await post(countedServer.url, { token: TOKEN, calls: Array.from({ length: 50 }, () => call({ storeId: 'x' })) });
  assert.equal(fifty.status, 200);
  assert.equal(fifty.json.results.length, 50);
});

test('outcomes: values, KVError fields, undefined args, open thrown synchronously', async () => {
  const { storeId } = await ref.admin.createStore({ format: 2 });
  const res = await post(main.url, { token: TOKEN, calls: [
    call({ storeId, method: 'set', args: ['a', { x: 1 }, null], undef: [2] }),
    call({ storeId, method: 'get', args: ['a'] }),
    call({ storeId: 'kvc-999', method: 'get', args: ['a'] }),
    call({ method: 'open', args: [123] }),
    call({ method: 'open', args: [storeId] }),
  ] });
  assert.equal(res.status, 200);
  const [set, get, forbidden, openBad, openOk] = res.json.results;
  assert.deepEqual(set, { ok: true, value: true });
  assert.deepEqual(get, { ok: true, value: { x: 1 } });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.sync, false);
  assert.equal(forbidden.error.code, 'FORBIDDEN');
  assert.equal(forbidden.error.status, 403);
  assert.equal(forbidden.error.instanceOfKVError, true);
  assert.equal(openBad.sync, true);
  assert.equal(openBad.error.code, 'VALIDATION');
  assert.deepEqual(openOk, { ok: true, value: { storeId, frozen: true } });
});

test('iteration runs in the function: items before the cap, then the error with its cursor', async () => {
  const { storeId } = await ref.admin.createStore({ format: 2 });
  for (let i = 0; i < 5; i += 1) await ref.kvStore.set(storeId, `c:${i}`, i);
  const res = await post(main.url, { token: TOKEN, calls: [
    call({ storeId, method: 'list', args: [{ collection: 'c', limit: 2 }], iterate: { mode: 'items', args: [{ maxPages: 1 }] } }),
    call({ storeId, shape: 'handle', method: 'list', args: [{ collection: 'c', limit: 2 }], iterate: { mode: 'pages', args: [{ maxPages: 5 }] } }),
  ] });
  const [items, pages] = res.json.results;
  assert.deepEqual(items.value.collected.map((i) => i.key), ['c:0', 'c:1']);
  assert.equal(items.value.error.code, 'LIMIT_EXCEEDED');
  assert.equal(typeof items.value.error.fields.cursor, 'string');
  assert.equal(pages.value.error, undefined);
  assert.equal(pages.value.collected.length, 3);
});

test('verifyChain in the function gives the same report as the local one', async () => {
  const chain = [1, 2, 4].map((seq) => ({ shard: '00', seq, hash: `h${seq}`, prevHash: seq === 1 ? 'g' : `h${seq - 1}` }));
  const res = await post(main.url, { token: TOKEN, calls: [
    call({ method: 'verifyChain', args: [chain] }),
    call({ shape: 'handle', method: 'verifyChain', args: [chain] }),
    call({ method: 'verifyChain', args: ['x'] }),
  ] });
  const [global, handle, bad] = res.json.results;
  assert.deepEqual(global.value, ref.kvStore.verifyChain(chain));
  assert.deepEqual(handle.value, global.value);
  assert.equal(bad.sync, true);
  assert.equal(bad.error.code, 'VALIDATION');
});

test('atomic: built and committed in the function, the second commit outcome kept', async () => {
  const { storeId } = await ref.admin.createStore({ format: 2 });
  const res = await post(main.url, { token: TOKEN, calls: [
    call({ storeId, method: 'atomic', ops: [{ op: 'set', args: ['a', 1] }, { op: 'increment', args: ['n'] }], commit: [{}, {}] }),
  ] });
  const [first, second] = res.json.results[0].value.outcomes;
  assert.equal(first.ok, true);
  assert.equal(first.value.replayed, false);
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'VALIDATION');
  assert.equal(await ref.kvStore.get(storeId, 'n'), 1, 'the second commit wrote nothing');
});

const proxyModule = (over = {}) => ({
  createAdapter: (options) => edge.createAdapter({ ...options, url: main.url, token: TOKEN, admin: ref.admin, ...over }),
});

test('the proxy adapter: name, shapes, capabilities, real clock, KVError not enumerable', async () => {
  const adapter = await proxyModule().createAdapter({});
  assert.equal(adapter.name, 'edge-harness');
  assert.deepEqual(adapter.shapes, ['global', 'handle']);
  assert.equal(adapter.clock.virtual, false);
  assert.ok(adapter.defaultTimeoutMs >= 60000, 'a realistic default case timeout for the rate cap');
  assert.deepEqual(adapter.capabilities, {
    virtualClock: false, eventualIndexLists: true, indexBuildStates: true, proofTiming: true, signedProofs: true,
    search: true, secretEncryption: true, subjectV1: false, setClock: false, advanceArchive: false, injectFault: false,
  });
  assert.equal(adapter.control, undefined);
  assert.equal(typeof adapter.kvStore.KVError, 'function');
  assert.ok(!Object.keys(adapter.kvStore).includes('KVError'));
  const { storeId } = await adapter.admin.createStore({ format: 2 });
  await adapter.kvStore.set(storeId, 'k', 1);
  assert.equal(await adapter.kvStore.open(storeId).get('k'), 1);
  const err = await adapter.kvStore.get('kvc-999', 'k').catch((e) => e);
  assert.ok(err instanceof adapter.kvStore.KVError);
  assert.equal(err.status, 403);
  assert.throws(() => adapter.kvStore.open(123), (e) => e instanceof adapter.kvStore.KVError && e.code === 'VALIDATION');
});

test('createAdapter names the missing variables, never a value', async () => {
  const secret = `value-${randomBytes(8).toString('hex')}`;
  const err = await edge.createAdapter({ env: { KVC_HARNESS_TOKEN: secret } }).catch((e) => e);
  assert.ok(err instanceof Error);
  for (const name of ['KVC_HARNESS_URL', 'KVC_API_BASE', 'KVC_ORG', 'KVC_PROJECT', 'KVC_API_TOKEN']) {
    assert.match(err.message, new RegExp(name));
  }
  assert.doesNotMatch(err.message, /KVC_HARNESS_TOKEN/);
  assert.ok(!err.message.includes(secret));
  const withAdmin = await edge.createAdapter({ admin: ref.admin, env: {} }).catch((e) => e);
  assert.match(withAdmin.message, /KVC_HARNESS_URL/);
  assert.match(withAdmin.message, /KVC_HARNESS_TOKEN/);
  assert.doesNotMatch(withAdmin.message, /KVC_API_BASE/);
});

test('the token is absent from transport errors', async () => {
  const wrong = await proxyModule({ token: `${TOKEN}-other` }).createAdapter({}).catch((e) => e);
  assert.ok(wrong instanceof Error);
  assert.match(wrong.message, /403/);
  const dead = await serve(async () => { throw new Error('down'); }, null);
  await dead.close();
  const closed = await edge.createAdapter({ url: dead.url, token: TOKEN, admin: ref.admin }).catch((e) => e);
  assert.ok(closed instanceof Error);
  const echo = await serve(async (event) => new Response(await event.request.text(), { status: 500 }), null);
  try {
    const echoed = await edge.createAdapter({ url: echo.url, token: TOKEN, admin: ref.admin }).catch((e) => e);
    assert.ok(echoed instanceof Error);
    for (const e of [wrong, closed, echoed]) {
      const text = [e.message, e.stack, JSON.stringify(e), String(e.cause?.message)].join('\n');
      assert.ok(!text.includes(TOKEN), `token in: ${e.message}`);
    }
  } finally {
    await echo.close();
  }
});

const ALLOWED_SKIPS = /^(needs (injectFault|virtualClock|shortPages|setClock|advanceArchive)|tag \S+ not selected)$/;

test('the default suite passes through the edge harness (proxy over the reference kvStore)', { timeout: 600000 }, async () => {
  const report = await run({ adapter: proxyModule() });
  const bad = report.results.filter((r) => r.status === 'fail' || r.status === 'error')
    .map((r) => `${r.name} [${r.shape}] ${r.status}: ${r.reason}`);
  assert.deepEqual(bad, []);
  const oddSkips = report.results.filter((r) => r.status === 'skip' && !ALLOWED_SKIPS.test(r.reason));
  assert.deepEqual(oddSkips.map((r) => `${r.name}: ${r.reason}`), []);
  assert.ok(report.summary.pass > 0);
  assert.equal(report.adapter, 'edge-harness');
  assert.ok(!JSON.stringify(report).includes(TOKEN), 'the token is not in the report');
  const skipped = report.results.filter((r) => r.status === 'skip').map((r) => `${r.name}: ${r.reason}`);
  process.stdout.write(`# edge-harness summary ${JSON.stringify(report.summary)}\n# skipped:\n# ${skipped.join('\n# ')}\n`);
});

// ---- fix round 1 ----

test('local open(): a probed rejection stays a rejection; a probed throw stays synchronous', async () => {
  const KVError = createKVErrorClass();
  const error = { name: 'KVError', code: 'VALIDATION', status: 400, retryable: false, instanceOfKVError: true, message: 'm', fields: {} };
  const send = async () => assert.fail('no request for open');
  const rejecting = buildProxyKvStore(send, KVError, { nonString: { ok: false, sync: false, error }, frozen: true });
  let result;
  assert.doesNotThrow(() => { result = rejecting.open(123); });
  await assert.rejects(result, (e) => e instanceof KVError && e.code === 'VALIDATION');
  const throwing = buildProxyKvStore(send, KVError, { nonString: { ok: false, sync: true, error }, frozen: true });
  assert.throws(() => throwing.open(123), (e) => e instanceof KVError && e.code === 'VALIDATION');
});

test('rebuildError does not let __proto__ or constructor fields through', () => {
  const KVError = createKVErrorClass();
  const info = JSON.parse('{"name":"KVError","code":"CONFLICT","instanceOfKVError":true,"message":"m",'
    + '"fields":{"__proto__":{"polluted":1},"constructor":"x","key":"k"}}');
  const err = rebuildError(info, KVError);
  assert.equal(Object.getPrototypeOf(err), KVError.prototype);
  assert.equal(err.polluted, undefined);
  assert.equal(err.constructor, KVError);
  assert.equal(err.key, 'k');
  assert.equal(({}).polluted, undefined);
  const odd = rebuildError({ name: '__proto__', message: 'm', fields: {} }, KVError);
  assert.ok(odd instanceof Error);
  assert.ok(!(odd instanceof KVError));
});

test('atomic: no second commit when the first commit failed', async () => {
  const { storeId } = await ref.admin.createStore({ format: 2 });
  await ref.kvStore.set(storeId, 'p', 1);
  const res = await post(main.url, { token: TOKEN, calls: [
    call({ storeId, method: 'atomic', ops: [{ op: 'check', args: ['p', null] }], commit: [{}, {}] }),
  ] });
  const [first, second] = res.json.results[0].value.outcomes;
  assert.equal(first.error.code, 'CONFLICT');
  assert.deepEqual(second, first, 'the first failure stands for the second commit (a run commit would be VALIDATION)');
});

// A stub kvStore whose outcomes JSON cannot carry.
const oddStore = {
  get: async () => {
    const value = { a: 1 };
    value.self = value;
    return value;
  },
  set: async () => {
    throw Object.assign(new Error('odd'), { code: 'X', key: { nested: true }, big: 1n, flag: true, empty: null });
  },
  open: () => Object.freeze({}),
};

test('result encoding: an outcome JSON cannot carry becomes HarnessEncodeError; non-scalar fields are marked', async () => {
  const server = await serve(harnessFn(TOKEN), oddStore);
  try {
    const res = await post(server.url, { token: TOKEN, calls: [call(), call({ method: 'set', args: ['k', 1] })] });
    assert.equal(res.status, 200);
    const [get, set] = res.json.results;
    assert.deepEqual(get, { ok: false, error: { name: 'HarnessEncodeError' } });
    assert.deepEqual(set.error.fields, { key: { nonScalar: true }, big: { nonScalar: true }, flag: true, empty: null });
  } finally {
    await server.close();
  }
});

test('a body over 1 MiB answers 413 and calls nothing', async () => {
  const before0 = counted.log.reads;
  const res = await post(countedServer.url, { token: TOKEN, calls: [call({ args: ['k', 'x'.repeat(1024 * 1024)] })] });
  assert.equal(res.status, 413);
  assert.equal(counted.log.reads, before0);
});

test('a token under 32 characters answers 503; a first-match replace configures the function', async () => {
  const short = await serve(harnessFn('short-token'), ref.kvStore);
  const first = new AsyncFunction('event', 'kvStore', `'use strict';\n${SOURCE.replace('__HARNESS_TOKEN__', TOKEN)}`);
  const once = await serve(first, ref.kvStore);
  try {
    const res = await post(short.url, { token: 'short-token', calls: [call()] });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /not configured/);
    assert.equal((await post(once.url, { token: TOKEN, calls: [call({ storeId: 'x' })] })).status, 200);
  } finally {
    await short.close();
    await once.close();
  }
});
