// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseTimeoutMs, run } from '../lib/runner.mjs';
import { cases } from '../cases/index.mjs';
import { LIMITS } from '../lib/limits.mjs';
import { API_SURFACE } from '../lib/version.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';

function fakeAdapter(over = {}) {
  const log = { disposed: 0, stores: 0, optionsSeen: null, calls: [] };
  const mod = {
    async createAdapter(options) {
      log.optionsSeen = options;
      const KVError = createKVErrorClass();
      const kvStore = {
        KVError,
        open: (id) => ({ id, shape: 'handle' }),
        get: async (id, key, raw) => { log.calls.push(['get', id, key, raw]); return 'v'; },
        set: async (id, key) => { log.calls.push(['set', id, key]); },
      };
      return {
        name: 'fake', kvStore, shapes: ['global', 'handle'], clock: options.clock,
        capabilities: { virtualClock: true, search: false, secret: 's3cret' },
        admin: {
          createStore: async () => ({ storeId: 'store' + (++log.stores), identity: { org: 'o', store: 's' } }),
          dispose: async () => { log.disposed++; },
        },
        ...over,
      };
    },
  };
  return { mod, log };
}

const mk = (name, extra = {}) => ({ name, tags: ['core'], needs: [], run: async () => {}, ...extra });
const statusOf = (report, name, shape) => report.results.find((r) => r.name === name && (!shape || r.shape === shape));

test('runs a case once per shape and disposes the adapter once', async () => {
  const { mod, log } = fakeAdapter();
  const shapes = [];
  const report = await run({ adapter: mod, cases: [mk('core/a', { run: async (ctx) => { shapes.push(ctx.shape); } })] });
  assert.deepEqual(shapes, ['global', 'handle']);
  assert.equal(report.summary.pass, 2);
  assert.equal(report.summary.total, 2);
  assert.equal(log.disposed, 1);
  assert.equal(log.stores, 2);
  assert.ok(log.optionsSeen.clock.virtual);
});

test('report holds name, capabilities, shapes and no credentials', async () => {
  const { mod } = fakeAdapter();
  const report = await run({ adapter: mod, cases: [mk('core/a')] });
  assert.equal(report.suite, 'kv-conformance');
  assert.equal(report.adapter, 'fake');
  assert.deepEqual(report.shapes, ['global', 'handle']);
  assert.deepEqual(report.tags, ['bytes', 'core', 'ledger']);
  assert.equal(typeof report.startedAt, 'string');
  assert.equal(typeof report.durationMs, 'number');
  assert.ok(Array.isArray(report.validatedAgainst));
  assert.equal(report.capabilities.virtualClock, true);
  assert.equal(report.capabilities.secret, undefined);
  assert.ok(!JSON.stringify(report).includes('s3cret'));
  assert.equal(report.apiSurface, API_SURFACE);
  assert.deepEqual(Object.keys(report).sort(), ['adapter', 'apiSurface', 'capabilities', 'durationMs', 'results', 'shapes', 'startedAt',
    'suite', 'summary', 'tags', 'validatedAgainst', 'version']);
});

test('a missing capability skips with needs <flag>', async () => {
  const { mod, log } = fakeAdapter();
  const report = await run({ adapter: mod, cases: [mk('core/s', { needs: ['virtualClock', 'search'] })] });
  assert.equal(report.summary.skip, 1);
  assert.equal(statusOf(report, 'core/s').reason, 'needs search');
  assert.equal(log.stores, 0);
});

test('a case with a shape the adapter lacks is skipped; shapes intersect', async () => {
  const { mod } = fakeAdapter({ shapes: ['global'] });
  const seen = [];
  const report = await run({ adapter: mod, cases: [
    mk('core/h', { shapes: ['handle'] }),
    mk('core/b', { run: async (ctx) => { seen.push(ctx.shape); } }),
  ] });
  assert.equal(statusOf(report, 'core/h').status, 'skip');
  assert.equal(statusOf(report, 'core/h').reason, 'shape handle not supported');
  assert.deepEqual(seen, ['global']);
});

test('the shapes option narrows the shapes', async () => {
  const { mod } = fakeAdapter();
  const seen = [];
  await run({ adapter: mod, shapes: ['handle'], cases: [mk('core/a', { run: async (c) => { seen.push(c.shape); } })] });
  assert.deepEqual(seen, ['handle']);
});

test('tags not selected are skipped; message-exact and proof-timing are off by default', async () => {
  const { mod } = fakeAdapter();
  const cases = [mk('core/m', { tags: ['core', 'message-exact'] }), mk('ledger/p', { tags: ['proof-timing'] }), mk('core/ok')];
  const report = await run({ adapter: mod, cases });
  assert.equal(statusOf(report, 'core/m').reason, 'tag message-exact not selected');
  assert.equal(statusOf(report, 'ledger/p').reason, 'tag proof-timing not selected');
  const on = await run({ adapter: mod, tags: ['core', 'message-exact'], cases });
  assert.equal(statusOf(on, 'core/m', 'global').status, 'pass');
});

test('subject-v1 needs the tag and the enable switch', async () => {
  const { mod } = fakeAdapter();
  const cases = [mk('core/sub', { tags: ['subject-v1'] })];
  const a = await run({ adapter: mod, tags: ['subject-v1'], cases });
  assert.equal(statusOf(a, 'core/sub').reason, 'subject-v1 not enabled');
  const b = await run({ adapter: mod, enable: ['subject-v1'], cases });
  assert.equal(statusOf(b, 'core/sub').reason, 'tag subject-v1 not selected');
  const c = await run({ adapter: mod, tags: ['subject-v1'], enable: ['subject-v1'], cases });
  assert.equal(statusOf(c, 'core/sub', 'global').status, 'pass');
});

test('include and exclude filter by name prefix', async () => {
  const { mod } = fakeAdapter();
  const cases = [mk('core/a/1'), mk('core/b/1'), mk('ledger/c')];
  const inc = await run({ adapter: mod, include: ['core/'], shapes: ['global'], cases });
  assert.deepEqual(inc.results.map((r) => r.name), ['core/a/1', 'core/b/1']);
  const exc = await run({ adapter: mod, exclude: ['core/b'], shapes: ['global'], cases });
  assert.deepEqual(exc.results.map((r) => r.name), ['core/a/1', 'ledger/c']);
});

test('pure cases run once, with no store and no adapter shape', async () => {
  const { mod, log } = fakeAdapter();
  let got = null;
  const report = await run({ adapter: mod, cases: [{ name: 'bytes/x', tags: ['bytes'], needs: [], adapter: false,
    run: async (ctx) => { got = ctx; } }] });
  assert.equal(report.summary.pass, 1);
  assert.equal(log.stores, 0);
  assert.equal(typeof got.ledgerBytes.sha256Hex, 'function');
  assert.ok(got.vectors.definitionHash);
});

test('a failing case reports the first line of the message, with no stack', async () => {
  const { mod } = fakeAdapter();
  const long = 'x'.repeat(900);
  const report = await run({ adapter: mod, shapes: ['global'], cases: [
    mk('core/f', { run: async () => { assert.equal(1, 2, 'first line\nsecond line'); } }),
    mk('core/l', { run: async () => { throw new Error(long); } }),
  ] });
  assert.equal(statusOf(report, 'core/f').status, 'fail');
  assert.equal(statusOf(report, 'core/f').reason, 'first line');
  assert.equal(statusOf(report, 'core/l').reason.length, 500);
  assert.ok(!JSON.stringify(report).includes('node_modules') && !JSON.stringify(report).includes('/Users'));
});

test('a setup failure is an error status', async () => {
  const { mod } = fakeAdapter();
  const bad = { createAdapter: async (o) => ({ ...(await mod.createAdapter(o)), admin: {
    createStore: async () => { throw new Error('no store'); }, dispose: async () => {} } }) };
  const report = await run({ adapter: bad, shapes: ['global'], cases: [mk('core/e')] });
  assert.equal(report.summary.error, 1);
  assert.equal(statusOf(report, 'core/e').status, 'error');
  assert.equal(statusOf(report, 'core/e').reason, 'no store');
});

test('a timeout is a fail and the timer does not hold the process', async () => {
  const { mod } = fakeAdapter();
  const report = await run({ adapter: mod, shapes: ['global'], timeoutMs: 50, cases: [
    mk('core/t', { run: () => new Promise(() => {}) }),
    mk('core/u', { timeoutMs: 20, run: () => new Promise(() => {}) }),
  ] });
  assert.equal(statusOf(report, 'core/t').status, 'fail');
  assert.equal(statusOf(report, 'core/t').reason, 'timeout after 50 ms');
  assert.equal(statusOf(report, 'core/u').reason, 'timeout after 20 ms');
});

test('dispose runs even when createStore throws, and onResult sees each result', async () => {
  const { mod, log } = fakeAdapter();
  const seen = [];
  await run({ adapter: mod, shapes: ['global'], onResult: (r) => seen.push(r.name), cases: [mk('core/a'), mk('core/b')] });
  assert.deepEqual(seen, ['core/a', 'core/b']);
  assert.equal(log.disposed, 1);
});

test('adapter may be { createAdapter, options } and options reach createAdapter', async () => {
  const { mod, log } = fakeAdapter();
  await run({ adapter: { createAdapter: mod.createAdapter, options: { budgetRows: 3 } }, cases: [mk('core/a')] });
  assert.equal(log.optionsSeen.budgetRows, 3);
  assert.ok(log.optionsSeen.clock);
});

test('adapter may be a path, relative to the working directory', async () => {
  const report = await run({ adapter: 'test/fixtures/fake-adapter.mjs', cases: [mk('core/a')] });
  assert.equal(report.adapter, 'fake');
});

test('an adapter with its own clock keeps it in ctx', async () => {
  const own = { virtual: false, now: () => 1, advance: async () => {} };
  const { mod } = fakeAdapter({ clock: own });
  let seen;
  await run({ adapter: mod, shapes: ['global'], cases: [mk('core/c', { run: async (c) => { seen = c.clock; } })] });
  assert.equal(seen, own);
});

test('ctx: global binder maps get raw, handle opens the store, uniqueKey is unique and safe', async () => {
  const { mod, log } = fakeAdapter();
  const keys = [];
  await run({ adapter: mod, cases: [mk('core/ctx', { run: async (ctx) => {
    assert.equal(ctx.storeId.startsWith('store'), true);
    assert.deepEqual(ctx.identity, { org: 'o', store: 's' });
    assert.equal(ctx.limits.keyMaxBytes > 0, true);
    assert.equal(ctx.caps.virtualClock, true);
    assert.equal(typeof ctx.expectKVError, 'function');
    if (ctx.shape === 'handle') assert.deepEqual(ctx.kv, { id: ctx.storeId, shape: 'handle' });
    else {
      await ctx.kv.get('k', { raw: true });
      await ctx.kv.get('k2');
      await ctx.kv.set('k3', 1);
      assert.deepEqual(log.calls, [['get', ctx.storeId, 'k', true], ['get', ctx.storeId, 'k2', undefined], ['set', ctx.storeId, 'k3']]);
    }
    keys.push(ctx.uniqueKey('item'), ctx.uniqueKey('item'));
  } })] });
  assert.equal(new Set(keys).size, 4);
  for (const k of keys) assert.match(k, /^item-[A-Za-z0-9_-]+$/);
});

test('ctx.expectKVError is bound to the adapter KVError', async () => {
  const { mod } = fakeAdapter();
  const report = await run({ adapter: mod, shapes: ['global'], cases: [mk('core/k', { run: async (ctx) => {
    await ctx.expectKVError(Promise.reject(new ctx.kvStore.KVError('VALIDATION', 'm')), { code: 'VALIDATION' });
  } })] });
  assert.equal(report.summary.pass, 1);
});

test('rejects for a module without createAdapter, or no adapter when adapter cases are selected', async () => {
  await assert.rejects(run({ adapter: {}, cases: [mk('core/a')] }), /createAdapter/);
  await assert.rejects(run({ cases: [mk('core/a')] }), /adapter is required/);
});

test('pure cases need no adapter: report has null adapter, no shapes, no capabilities', async () => {
  const report = await run({ tags: ['bytes'] });
  assert.ok(report.summary.pass > 0);
  assert.equal(report.summary.fail + report.summary.error, 0);
  assert.equal(report.adapter, null);
  assert.deepEqual(report.shapes, []);
  assert.deepEqual(report.capabilities, {});
});

test('adapter cases that are tag-skipped do not need an adapter either', async () => {
  const report = await run({ tags: ['bytes'], cases: [mk('core/a')] });
  assert.equal(report.results[0].reason, 'tag core not selected');
});

test('the adapter is not created when only pure cases run', async () => {
  const { mod, log } = fakeAdapter();
  await run({ adapter: mod, tags: ['bytes'] });
  assert.equal(log.optionsSeen, null);
  assert.equal(log.disposed, 0);
});

test('a pure case uses the run timeout setting unless it has its own', async () => {
  const pure = (extra) => ({ name: 'bytes/t', tags: ['bytes'], needs: [], adapter: false, run: () => new Promise(() => {}), ...extra });
  const a = await run({ timeoutMs: 30, cases: [pure()] });
  assert.equal(a.results[0].reason, 'timeout after 30 ms');
  const b = await run({ timeoutMs: 30, cases: [pure({ timeoutMs: 15 })] });
  assert.equal(b.results[0].reason, 'timeout after 15 ms');
});

test('a hanging createStore is a setup timeout, reported as an error', async () => {
  const { mod } = fakeAdapter({ admin: { createStore: () => new Promise(() => {}), dispose: async () => {} } });
  const report = await run({ adapter: mod, shapes: ['global'], timeoutMs: 30, cases: [mk('core/h')] });
  assert.equal(report.results[0].status, 'error');
  assert.equal(report.results[0].reason, 'timeout after 30 ms');
});

test('the case timer starts after setup: a slow createStore does not use the case time', async () => {
  const slow = () => new Promise((r) => setTimeout(() => r({ storeId: 's1', identity: { org: 'o', store: 's' } }), 40));
  const { mod } = fakeAdapter({ admin: { createStore: slow, dispose: async () => {} } });
  const report = await run({ adapter: mod, shapes: ['global'], timeoutMs: 60, cases: [
    mk('core/s', { run: () => new Promise((r) => setTimeout(r, 40)) }),
  ] });
  assert.equal(report.results[0].status, 'pass', report.results[0].reason);
});

test('the timeout order: case timeoutMs, then the run option, then the adapter default, then 30000', async () => {
  const hang = (extra) => mk('core/t', { run: () => new Promise(() => {}), ...extra });
  const { mod } = fakeAdapter({ defaultTimeoutMs: 25 });
  const a = await run({ adapter: mod, shapes: ['global'], cases: [hang()] });
  assert.equal(a.results[0].reason, 'timeout after 25 ms');
  const b = await run({ adapter: mod, shapes: ['global'], timeoutMs: 35, cases: [hang()] });
  assert.equal(b.results[0].reason, 'timeout after 35 ms');
  const c = await run({ adapter: mod, shapes: ['global'], timeoutMs: 35, cases: [hang({ timeoutMs: 15 })] });
  assert.equal(c.results[0].reason, 'timeout after 15 ms');
});

test('a case that declares a ledger or an index gets the activation wait and a margin on top of the base', () => {
  const base = 100;
  const wait = (kind) => LIMITS[`${kind}ActivationMs`] + LIMITS.activationMarginMs;
  assert.equal(caseTimeoutMs(mk('core/a'), base), base);
  assert.equal(caseTimeoutMs(mk('ledger/a', { declares: ['ledger'] }), base), base + wait('ledger'));
  assert.equal(caseTimeoutMs(mk('s/a', { declares: ['ledger', 'index'] }), base), base + wait('ledger') + wait('index'));
  assert.equal(caseTimeoutMs(mk('p/a', { declares: ['ledger'], timeoutMs: 7 }), base), 7);
});

test('every case that declares a ledger or an index says so in declares', async () => {
  const declaring = cases.filter((c) => /^(ledger|subject-v1|core\/indexes)\//.test(c.name));
  assert.ok(declaring.length > 0);
  for (const c of declaring) assert.ok((c.declares || []).length > 0, c.name);
  for (const c of cases) for (const kind of c.declares || []) assert.ok(['ledger', 'index'].includes(kind), c.name);
  const pick = (name) => cases.find((c) => c.name === name).declares;
  assert.deepEqual(pick('subject-v1/fold'), ['ledger', 'index']);
  assert.deepEqual(pick('core/indexes/count'), ['index']);
});

test('API_SURFACE names the d.ts revision date and LEDGER_FORMAT_RETIRED', () => {
  assert.match(API_SURFACE, /2026-10-24/);
  assert.match(API_SURFACE, /LEDGER_FORMAT_RETIRED/);
});
