// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The public API adapter's pacing and retry policy with a stub fetch: the token bucket below 1 request per second,
// the admin retry of 429 and 503 (Retry-After honoured and capped, attempts bounded), admin waits that never pass
// the poll deadline, and data calls that are never retried.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTokenBucket, createPublicApi } from '../adapters/http/lib/public-api.mjs';
import { createAdmin, MAX_ATTEMPTS, RETRY_AFTER_MAX_MS } from '../adapters/http/lib/admin.mjs';
import * as http from '../adapters/http/index.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { createVirtualClock } from '../lib/clock.mjs';

const TOKEN = 'kvc-retry-test-token-0123456789abcdef';
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
const busy = (status, retryAfter) => json(status, { error: true, code: 'RATE_LIMITED', message: 'busy', retryable: true },
  retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) });

// A virtual clock that records each wait.
function recordingClock() {
  const clock = createVirtualClock(0);
  const waits = [];
  return { clock: { ...clock, advance: (ms) => { waits.push(ms); return clock.advance(ms); } }, waits };
}

// An admin over a stub fetch that answers from `answer(method, url, n)` (n: the request number, from 1).
function adminWith(answer, { pollMs = 1000 } = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ method: init.method, url });
    return answer(init.method, url, sent.length);
  };
  const api = createPublicApi({ base: 'http://api.test', org: 'o', project: 'p', token: TOKEN, rate: 1000, fetch,
    KVError: createKVErrorClass() });
  const { clock, waits } = recordingClock();
  const admin = createAdmin({ api, org: 'o', stores: new Map(), clock, pollMs, log: () => {} });
  return { admin, sent, waits, clock };
}

test('token bucket: a rate below 1 per second paces one request every 1/rate seconds', async () => {
  let now = 0;
  const bucket = createTokenBucket(0.5, { now: () => now, sleep: async (ms) => { now += ms; } });
  const times = [];
  for (let i = 0; i < 4; i += 1) {
    await bucket.take();
    times.push(now);
  }
  assert.deepEqual(times, [0, 2000, 4000, 6000]);
});

test('token bucket: a rate of 3 keeps a burst of 3, then one request every 1/3 s', async () => {
  let now = 0;
  const bucket = createTokenBucket(3, { now: () => now, sleep: async (ms) => { now += ms; } });
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    await bucket.take();
    times.push(now);
  }
  assert.deepEqual(times.slice(0, 3), [0, 0, 0]);
  assert.ok(times[3] >= 333 && times[3] <= 334, `fourth at ${times[3]}`);
  assert.ok(times[4] >= 666 && times[4] <= 668, `fifth at ${times[4]}`);
});

test('admin: 429 and 503 answers are sent again after Retry-After, then the call succeeds', async () => {
  const answers = [busy(429, 2), busy(503, 1), json(204)];
  const { admin, sent, waits } = adminWith((method, url, n) => answers[n - 1]);
  await admin.dropIndex('s1', 'byName');
  assert.equal(sent.length, 3);
  assert.ok(sent.every((s) => s.method === 'DELETE'));
  assert.deepEqual(waits, [2000, 1000]);
});

test('admin: a retryable answer without Retry-After waits pollMs', async () => {
  const answers = [busy(503), json(204)];
  const { admin, waits } = adminWith((method, url, n) => answers[n - 1], { pollMs: 1234 });
  await admin.dropLedger('s1', 'audit');
  assert.deepEqual(waits, [1234]);
});

test('admin: retries are bounded; the last error is thrown', async () => {
  const { admin, sent } = adminWith(() => busy(503, 1));
  const err = await admin.dropIndex('s1', 'byName').catch((e) => e);
  assert.equal(sent.length, MAX_ATTEMPTS);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.status, 503);
});

test('admin: a non-retryable error is not sent again', async () => {
  const { admin, sent } = adminWith(() => json(409, { error: true, code: 'CONFLICT', message: 'no', retryable: false }));
  await assert.rejects(admin.dropIndex('s1', 'byName'));
  assert.equal(sent.length, 1);
});

test('admin: a long Retry-After is capped', async () => {
  const answers = [busy(429, 3600), json(204)];
  const { admin, waits } = adminWith((method, url, n) => answers[n - 1]);
  await admin.dropIndex('s1', 'byName');
  assert.deepEqual(waits, [RETRY_AFTER_MAX_MS]);
});

test('admin: a poll never sleeps past its deadline and then fails', async () => {
  const building = () => json(200, { name: 'byName', state: 'BUILDING' });
  const { admin, waits, clock } = adminWith(building, { pollMs: 400000 });
  const err = await admin.declareIndex('s1', { name: 'byName', field: 'name' }).catch((e) => e);
  assert.match(err.message, /did not finish in time/);
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 900000, `waited ${total} ms in all`);
  assert.equal(clock.now(), total);
  assert.ok(waits.every((ms) => ms > 0), `waits ${waits}`);
});

test('admin: a retry inside a poll never sleeps past the poll deadline', async () => {
  // Each poll cycle: seven 429 answers with a Retry-After at the cap, then BUILDING (430 s a cycle with pollMs).
  let gets = 0;
  const { admin, waits } = adminWith((method) => {
    if (method === 'POST') return json(201, { name: 'byName', state: 'BUILDING' });
    gets += 1;
    return gets % 8 === 0 ? json(200, { name: 'byName', state: 'BUILDING' }) : busy(429, RETRY_AFTER_MAX_MS / 1000);
  }, { pollMs: 10000 });
  const err = await admin.declareIndex('s1', { name: 'byName', field: 'name' }).catch((e) => e);
  assert.ok(err instanceof Error);
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 900000, `waited ${total} ms in all`);
});

test('a data call that answers a retryable 503 is not sent again', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(init.method);
    if (init.method === 'POST') return json(201, { id: 'store-1', status: 'ready' });
    return busy(503, 1);
  };
  const env = { KVC_API_BASE: 'http://api.test', KVC_ORG: 'o', KVC_PROJECT: 'p', KVC_API_TOKEN: TOKEN, KVC_RATE: '1000' };
  const adapter = await http.createAdapter({ env, fetch, log: () => {} });
  const { storeId } = await adapter.admin.createStore();
  const err = await adapter.kvStore.set(storeId, 'k', { a: 1 }).catch((e) => e);
  assert.ok(err instanceof adapter.kvStore.KVError);
  assert.equal(err.retryable, true);
  assert.deepEqual(sent, ['POST', 'PUT']);
});

test('admin: Retry-After 0 means retry now (a small wait), not a passed deadline', async () => {
  const answers = [busy(429, 0), json(204)];
  const { admin, sent, waits } = adminWith((method, url, n) => answers[n - 1]);
  await admin.dropIndex('s1', 'byName');
  assert.equal(sent.length, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 1000, `wait ${waits[0]}`);
});

test('admin: a poll answer with Retry-After 0 polls again soon', async () => {
  const answers = [json(200, { name: 'byName', state: 'BUILDING' }),
    json(200, { name: 'byName', state: 'BUILDING' }, { 'retry-after': '0' }), json(200, { name: 'byName', state: 'ACTIVE' })];
  const { admin, waits } = adminWith((method, url, n) => answers[Math.min(n, 3) - 1]);
  const declared = await admin.declareIndex('s1', { name: 'byName', field: 'name' }, { wait: true }).catch((e) => e);
  assert.ok(!(declared instanceof Error), declared?.message);
  assert.equal(declared.state, 'ACTIVE');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 1000, `waits ${waits}`);
});
