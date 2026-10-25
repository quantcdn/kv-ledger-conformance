// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildKvStore, BASE_METHODS } from '../lib/edge-surface.mjs';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { LIMITS } from '../lib/limits.mjs';

const KVError = createKVErrorClass();
const METHODS = ['get', 'set', 'delete', 'getEntry', 'getMany', 'getBy', 'count', 'increment', 'list', 'search',
  'append', 'ledgerStatus', 'ledgerProof', 'atomic'];

// A fake base. `pages` is the page sequence list/search walk: page i has cursor `c<i+1>` until the last.
function fakeBase({ pages = [{ items: [], cursor: null, hasMore: false }], firstRejects = false } = {}) {
  const calls = [];
  const base = {};
  for (const name of METHODS) {
    base[name] = async (...args) => {
      calls.push([name, ...args]);
      return { method: name };
    };
  }
  const page = (storeId, opts = {}) => {
    const i = opts.cursor === undefined ? 0 : Number(opts.cursor.slice(1));
    if (i === 0 && firstRejects) return Promise.reject(new KVError('UNAVAILABLE', 'down', { retryable: true }));
    return Promise.resolve(pages[i]);
  };
  base.list = async (storeId, opts) => {
    calls.push(['list', storeId, opts]);
    return page(storeId, opts);
  };
  base.search = async (storeId, opts) => {
    calls.push(['search', storeId, opts]);
    return page(storeId, opts);
  };
  return { base, calls };
}

// n pages of `per` items; the last has hasMore false and cursor null.
function makePages(n, per = 2) {
  return Array.from({ length: n }, (_, i) => ({
    items: Array.from({ length: per }, (__, j) => ({ key: `k${i * per + j}` })),
    cursor: i === n - 1 ? null : `c${i + 1}`,
    hasMore: i !== n - 1,
  }));
}

async function collect(iterable) {
  const out = [];
  for await (const x of iterable) out.push(x);
  return out;
}

async function rejectsWith(promise, code, check = () => {}) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof KVError, 'instanceof KVError');
    assert.equal(err.code, code);
    assert.equal(err.retryable, false);
    assert.equal(err.status, undefined);
    check(err);
    return true;
  });
}

function throwsValidation(fn) {
  assert.throws(fn, (err) => err instanceof KVError && err.code === 'VALIDATION' && err.status === undefined);
}

// ---- construction ----
test('BASE_METHODS lists the base methods', () => {
  assert.deepEqual([...BASE_METHODS].sort(), [...METHODS].sort());
});

test('kvStore has every method, open and verifyChain; KVError is the given class and not enumerable', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  for (const name of [...METHODS, 'open', 'verifyChain']) assert.equal(typeof kv[name], 'function', name);
  assert.equal(kv.KVError, KVError);
  assert.ok(!Object.keys(kv).includes('KVError'));
  assert.equal(Object.getOwnPropertyDescriptor(kv, 'KVError').enumerable, false);
});

test('buildKvStore refuses a base without a method, or a missing class', () => {
  const { base } = fakeBase();
  delete base.ledgerProof;
  assert.throws(() => buildKvStore(base, KVError), TypeError);
  assert.throws(() => buildKvStore(fakeBase().base, undefined), TypeError);
});

test('buildKvStore does not change the base', () => {
  const { base } = fakeBase();
  const before = { ...base };
  const kv = buildKvStore(base, KVError);
  assert.notEqual(kv, base);
  assert.deepEqual(base, before);
});

// ---- pass-through ----
test('methods pass their arguments to the base, store id first', async () => {
  const { base, calls } = fakeBase();
  const kv = buildKvStore(base, KVError);
  assert.deepEqual(await kv.set('s', 'k', 1, { ttl: LIMITS.ttl.min }), { method: 'set' });
  await kv.append('s', 'audit', { a: 1 }, { idempotencyKey: 'x' });
  await kv.ledgerProof('s', 'audit', 'audit:1');
  assert.deepEqual(calls, [
    ['set', 's', 'k', 1, { ttl: LIMITS.ttl.min }],
    ['append', 's', 'audit', { a: 1 }, { idempotencyKey: 'x' }],
    ['ledgerProof', 's', 'audit', 'audit:1'],
  ]);
});

test('global get passes skipDecode as a boolean', async () => {
  const { base, calls } = fakeBase();
  const kv = buildKvStore(base, KVError);
  await kv.get('s', 'k');
  await kv.get('s', 'k', 1);
  await kv.get('s', 'k', true);
  assert.deepEqual(calls, [['get', 's', 'k', false], ['get', 's', 'k', true], ['get', 's', 'k', true]]);
});

test('a synchronous throw in the base becomes a rejection', async () => {
  const { base } = fakeBase();
  base.getEntry = () => {
    throw new KVError('VALIDATION', 'bad');
  };
  const kv = buildKvStore(base, KVError);
  let p;
  assert.doesNotThrow(() => {
    p = kv.getEntry('s', 'k');
  });
  await assert.rejects(p, (e) => e.code === 'VALIDATION');
});

// ---- iteration ----
for (const method of ['list', 'search']) {
  test(`${method}: await gives the first page`, async () => {
    const pages = makePages(3);
    const kv = buildKvStore(fakeBase({ pages }).base, KVError);
    assert.deepEqual(await kv[method]('s', { prefix: 'a' }), pages[0]);
  });

  test(`${method}: pages() walks every page and passes the cursor with the same options`, async () => {
    const pages = makePages(3);
    const { base, calls } = fakeBase({ pages });
    const kv = buildKvStore(base, KVError);
    const got = await collect(kv[method]('s', { prefix: 'a', limit: 2 }).pages());
    assert.deepEqual(got, pages);
    assert.deepEqual(calls, [
      [method, 's', { prefix: 'a', limit: 2 }],
      [method, 's', { prefix: 'a', limit: 2, cursor: 'c1' }],
      [method, 's', { prefix: 'a', limit: 2, cursor: 'c2' }],
    ]);
  });

  test(`${method}: items() and for-await give every item in order`, async () => {
    const pages = makePages(4, 3);
    const kv = buildKvStore(fakeBase({ pages }).base, KVError);
    const want = pages.flatMap((p) => p.items);
    assert.deepEqual(await collect(kv[method]('s', {}).items()), want);
    assert.deepEqual(await collect(kv[method]('s', {})), want);
  });
}

test('iteration with no options sends no options object of its own', async () => {
  const pages = makePages(2);
  const { base, calls } = fakeBase({ pages });
  const kv = buildKvStore(base, KVError);
  await collect(kv.list('s'));
  assert.deepEqual(calls, [['list', 's', undefined], ['list', 's', { cursor: 'c1' }]]);
});

test('an empty page with hasMore true continues', async () => {
  const pages = [
    { items: [{ key: 'a' }], cursor: 'c1', hasMore: true, pageEnd: 'limit' },
    { items: [], cursor: 'c2', hasMore: true, pageEnd: 'budget' },
    { items: [{ key: 'b' }], cursor: null, hasMore: false, pageEnd: 'end' },
  ];
  const kv = buildKvStore(fakeBase({ pages }).base, KVError);
  assert.deepEqual((await collect(kv.list('s', {}))).map((i) => i.key), ['a', 'b']);
});

test('iteration stops when hasMore is false, even with a cursor', async () => {
  const pages = [{ items: [{ key: 'a' }], cursor: 'c1', hasMore: false }, { items: [{ key: 'x' }], cursor: null, hasMore: false }];
  const { base, calls } = fakeBase({ pages });
  await collect(buildKvStore(base, KVError).list('s', {}));
  assert.equal(calls.length, 1);
});

test('iteration stops when the cursor is null, even with hasMore true', async () => {
  const pages = [{ items: [{ key: 'a' }], cursor: null, hasMore: true }, { items: [{ key: 'x' }], cursor: null, hasMore: false }];
  const { base, calls } = fakeBase({ pages });
  assert.equal((await collect(buildKvStore(base, KVError).list('s', {}))).length, 1);
  assert.equal(calls.length, 1);
});

test('a page without items is treated as empty', async () => {
  const pages = [{ cursor: 'c1', hasMore: true }, { items: [{ key: 'b' }], cursor: null, hasMore: false }];
  const kv = buildKvStore(fakeBase({ pages }).base, KVError);
  assert.deepEqual(await collect(kv.list('s', {})), [{ key: 'b' }]);
});

test('default cap: more pages than maxPages.default throws LIMIT_EXCEEDED with the next cursor', async () => {
  const cap = LIMITS.maxPages.default;
  const pages = makePages(cap + 2);
  const { base, calls } = fakeBase({ pages });
  const kv = buildKvStore(base, KVError);
  const seen = [];
  const run = async () => {
    for await (const item of kv.list('s', {})) seen.push(item);
  };
  await rejectsWith(run(), 'LIMIT_EXCEEDED', (err) => assert.equal(err.cursor, pages[cap - 1].cursor));
  assert.equal(seen.length, cap * 2);
  assert.equal(calls.length, cap);
});

test('maxPages caps pages(); exactly maxPages pages with nothing left does not throw', async () => {
  const pages = makePages(5);
  const kv = buildKvStore(fakeBase({ pages }).base, KVError);
  await rejectsWith(collect(kv.list('s', {}).pages({ maxPages: 2 })), 'LIMIT_EXCEEDED', (e) => assert.equal(e.cursor, 'c2'));
  assert.equal((await collect(kv.list('s', {}).pages({ maxPages: 5 }))).length, 5);
  assert.equal((await collect(kv.list('s', {}).items({ maxPages: LIMITS.maxPages.max }))).length, 10);
});

test('resume from the LIMIT_EXCEEDED cursor reaches the rest without repeats', async () => {
  const pages = makePages(5);
  const kv = buildKvStore(fakeBase({ pages }).base, KVError);
  const seen = [];
  let cursor;
  try {
    for await (const item of kv.list('s', {}).items({ maxPages: LIMITS.maxPages.min })) seen.push(item.key);
  } catch (e) {
    cursor = e.cursor;
  }
  for await (const item of kv.list('s', { cursor }).items({ maxPages: LIMITS.maxPages.max })) seen.push(item.key);
  assert.deepEqual(seen, pages.flatMap((p) => p.items.map((i) => i.key)));
});

const BAD_ITERATION_OPTIONS = [
  ['maxPages under min', { maxPages: LIMITS.maxPages.min - 1 }],
  ['maxPages over max', { maxPages: LIMITS.maxPages.max + 1 }],
  ['maxPages fraction', { maxPages: LIMITS.maxPages.min + 0.5 }],
  ['maxPages string', { maxPages: String(LIMITS.maxPages.min) }],
  ['unknown option', { pageCap: 2 }],
  ['null', null],
  ['array', []],
  ['number', 3],
];
for (const [name, opts] of BAD_ITERATION_OPTIONS) {
  test(`iteration options VALIDATION: ${name}`, () => {
    const kv = buildKvStore(fakeBase({ pages: makePages(2) }).base, KVError);
    throwsValidation(() => kv.list('s', {}).pages(opts));
    throwsValidation(() => kv.search('s', {}).items(opts));
  });
}

test('maxPages undefined and {} use the default', async () => {
  const kv = buildKvStore(fakeBase({ pages: makePages(3) }).base, KVError);
  assert.equal((await collect(kv.list('s', {}).pages({}))).length, 3);
  assert.equal((await collect(kv.list('s', {}).pages({ maxPages: undefined }))).length, 3);
});

test('a first-page rejection reaches the iteration', async () => {
  const kv = buildKvStore(fakeBase({ firstRejects: true }).base, KVError);
  await assert.rejects(collect(kv.list('s', {})), (e) => e.code === 'UNAVAILABLE');
  await assert.rejects(kv.search('s', {}), (e) => e.code === 'UNAVAILABLE');
});

test('invalid iteration options mark a rejected first page as handled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const kv = buildKvStore(fakeBase({ firstRejects: true }).base, KVError);
    throwsValidation(() => kv.list('s', {}).pages({ maxPages: 0 }));
    throwsValidation(() => kv.search('s', {}).items({ bogus: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

// ---- open ----
test('open: a non-string store id throws VALIDATION synchronously', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  for (const bad of [123, undefined, null, {}, ['s']]) throwsValidation(() => kv.open(bad));
});

test('open: a frozen handle with storeId and every method; calls carry the store id', async () => {
  const { base, calls } = fakeBase();
  const kv = buildKvStore(base, KVError);
  const h = kv.open('s1');
  assert.ok(Object.isFrozen(h));
  assert.equal(h.storeId, 's1');
  for (const name of [...METHODS, 'verifyChain']) assert.equal(typeof h[name], 'function', name);
  assert.equal(h.verifyChain, kv.verifyChain);
  await h.set('k', 1, { ttl: LIMITS.ttl.min });
  await h.getMany(['a', 'b']);
  await h.count({ index: 'byX' });
  await h.ledgerStatus('audit');
  assert.deepEqual(calls, [
    ['set', 's1', 'k', 1, { ttl: LIMITS.ttl.min }],
    ['getMany', 's1', ['a', 'b']],
    ['count', 's1', { index: 'byX' }],
    ['ledgerStatus', 's1', 'audit'],
  ]);
});

test('open: handle.list iterates', async () => {
  const pages = makePages(3);
  const kv = buildKvStore(fakeBase({ pages }).base, KVError);
  assert.equal((await collect(kv.open('s').list({ prefix: 'a' }))).length, 6);
  assert.deepEqual(await kv.open('s').search({ prefix: 'a' }), pages[0]);
});

test('open: handle.get maps undefined, booleans and { raw } to skipDecode', async () => {
  const { base, calls } = fakeBase();
  const h = buildKvStore(base, KVError).open('s');
  await h.get('k');
  await h.get('k', undefined);
  await h.get('k', true);
  await h.get('k', false);
  await h.get('k', { raw: true });
  await h.get('k', { raw: false });
  await h.get('k', {});
  assert.deepEqual(calls.map((c) => c[3]), [false, false, true, false, true, false, false]);
  assert.ok(calls.every((c) => c[0] === 'get' && c[1] === 's' && c[2] === 'k'));
});

for (const [name, opts] of [['unknown name', { bogus: 1 }], ['raw not boolean', { raw: 'yes' }], ['null', null],
  ['number', 1], ['string', 'raw'], ['array', []]]) {
  test(`open: handle.get options VALIDATION: ${name}`, async () => {
    const { base, calls } = fakeBase();
    const h = buildKvStore(base, KVError).open('s');
    let p;
    assert.doesNotThrow(() => {
      p = h.get('k', opts);
    });
    await rejectsWith(p, 'VALIDATION');
    assert.equal(calls.length, 0);
  });
}

// ---- atomic ----
test('atomic: the builder collects operations and commit sends them once', async () => {
  const { base, calls } = fakeBase();
  const kv = buildKvStore(base, KVError);
  const b = kv.atomic('s');
  assert.equal(b.check('a', null), b);
  b.set('b', { n: 1 }, { ttl: LIMITS.ttl.min }).delete('c', { ifVersion: 'v1' }).increment('d').increment('e', 2);
  assert.deepEqual(await b.commit({ idempotencyKey: 'order-42' }), { method: 'atomic' });
  assert.deepEqual(calls, [['atomic', 's', [
    { op: 'check', key: 'a', version: null },
    { op: 'set', key: 'b', value: { n: 1 }, options: { ttl: LIMITS.ttl.min } },
    { op: 'delete', key: 'c', options: { ifVersion: 'v1' } },
    { op: 'increment', key: 'd', amount: undefined },
    { op: 'increment', key: 'e', amount: 2 },
  ], { idempotencyKey: 'order-42' }]]);
});

test('atomic: a second commit rejects with VALIDATION and sends nothing', async () => {
  const { base, calls } = fakeBase();
  const b = buildKvStore(base, KVError).atomic('s').set('a', 1);
  await b.commit();
  await rejectsWith(b.commit(), 'VALIDATION');
  assert.equal(calls.length, 1);
});

test('atomic: a second commit is refused even while the first is in flight or failed', async () => {
  const { base } = fakeBase();
  base.atomic = async () => {
    throw new KVError('CONFLICT', 'no', { status: 409 });
  };
  const b = buildKvStore(base, KVError).open('s').atomic().set('a', 1);
  const first = b.commit();
  await rejectsWith(b.commit(), 'VALIDATION');
  await assert.rejects(first, (e) => e.code === 'CONFLICT');
});

test('atomic: operations added after commit do not reach the sent list', async () => {
  const { base, calls } = fakeBase();
  const b = buildKvStore(base, KVError).atomic('s').set('a', 1);
  await b.commit();
  b.set('z', 2);
  assert.equal(calls[0][2].length, 1);
});

// ---- verifyChain ----
const H = (n) => `h${n}`;
const entry = (shard, seq, prev = seq === 1 ? 'g' : H(`${shard}-${seq - 1}`), hash = H(`${shard}-${seq}`)) => ({ shard, seq, hash, prevHash: prev });
const chain = (shard, n) => Array.from({ length: n }, (_, i) => entry(shard, i + 1));

test('verifyChain: a clean chain', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const r = kv.verifyChain(chain('00', 4).reverse());
  assert.deepEqual(r, { ok: true, checked: 4, shards: [{ shard: '00', first: 1, last: 4, count: 4 }], problems: [] });
});

test('verifyChain: empty input', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  assert.deepEqual(kv.verifyChain([]), { ok: true, checked: 0, shards: [], problems: [] });
});

test('verifyChain: gap', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const c = chain('00', 4);
  const r = kv.verifyChain([c[0], c[1], c[3]]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ problem: 'gap', shard: '00', seq: 4 }]);
  assert.deepEqual(r.shards, [{ shard: '00', first: 1, last: 4, count: 3 }]);
});

test('verifyChain: fork (two hashes, one seq)', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const c = chain('00', 2);
  const r = kv.verifyChain([...c, entry('00', 2, H('00-1'), 'zzz')]);
  assert.deepEqual(r.problems, [{ problem: 'fork', shard: '00', seq: 2 }]);
  assert.equal(r.checked, 3);
});

test('verifyChain: broken-link', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const c = chain('00', 3);
  c[2] = { ...c[2], prevHash: 'wrong' };
  assert.deepEqual(kv.verifyChain(c).problems, [{ problem: 'broken-link', shard: '00', seq: 3 }]);
});

test('verifyChain: missing-fields with the index; such entries are not counted', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const good = entry('00', 1);
  const bad = [
    null, 'x', {}, { ...good, hash: undefined }, { ...good, prevHash: null }, { ...good, seq: 0 }, { ...good, seq: 1.5 },
    { ...good, shard: { a: 1 } }, { ...good, shard: NaN }, { ...good, seq: '1' },
  ];
  const r = kv.verifyChain([good, ...bad]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, bad.map((_, i) => ({ problem: 'missing-fields', index: i + 1 })));
  assert.equal(r.checked, 1);
});

test('verifyChain: duplicates (same seq and hash) count once', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const c = chain('00', 3);
  const r = kv.verifyChain([...c, ...c, { ...c[1] }]);
  assert.deepEqual(r, { ok: true, checked: 3, shards: [{ shard: '00', first: 1, last: 3, count: 3 }], problems: [] });
});

test('verifyChain: shards are separate chains, sorted by shard', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const r = kv.verifyChain([...chain('03', 2), ...chain('00', 3), ...chain('01', 1)]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.shards.map((s) => s.shard), ['00', '01', '03']);
  assert.equal(r.checked, 6);
});

test('verifyChain: shards group by String(shard) and sort as text', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const r = kv.verifyChain([...chain(10, 1), ...chain(2, 1)]);
  assert.deepEqual(r.shards.map((s) => s.shard), [10, 2]);
});

test('verifyChain: 1 and "1" are one shard, reported with the first-seen value', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const [a, b] = chain('x', 2).map((e) => ({ ...e }));
  const r = kv.verifyChain([{ ...b, shard: '1' }, { ...a, shard: 1 }]);
  assert.deepEqual(r, { ok: true, checked: 2, shards: [{ shard: '1', first: 1, last: 2, count: 2 }], problems: [] });
});

test('verifyChain: list items with a ledger block', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const items = chain('00', 3).map((l, i) => ({ key: `audit:${i}`, encrypted: false, ledger: { name: 'audit', ...l } }));
  assert.deepEqual(kv.verifyChain(items).shards, [{ shard: '00', first: 1, last: 3, count: 3 }]);
});

test('verifyChain: the result does not depend on input order', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  const c = [...chain('00', 3), entry('00', 2, H('00-1'), 'aaa'), ...chain('01', 2)];
  const a = kv.verifyChain(c);
  const b = kv.verifyChain([...c].reverse());
  assert.deepEqual(a, b);
});

test('verifyChain: not an array, or over verifyChainMaxEntries, is VALIDATION', () => {
  const kv = buildKvStore(fakeBase().base, KVError);
  for (const bad of [undefined, null, {}, 'x', { length: 1 }]) throwsValidation(() => kv.verifyChain(bad));
  throwsValidation(() => kv.verifyChain(new Array(LIMITS.verifyChainMaxEntries + 1).fill(null)));
  assert.equal(kv.verifyChain(chain('00', LIMITS.verifyChainMaxEntries)).checked, LIMITS.verifyChainMaxEntries);
});

test('iteration: a break stops further requests; next() after the end and after an error is done', async () => {
  const pages = makePages(4);
  const { base, calls } = fakeBase({ pages });
  const kv = buildKvStore(base, KVError);
  for await (const item of kv.list('s', {})) {
    assert.equal(item.key, 'k0');
    break;
  }
  assert.equal(calls.length, 1);
  const it = kv.list('s', {}).pages({ maxPages: 1 });
  assert.equal((await it.next()).done, false);
  await assert.rejects(it.next(), (e) => e.code === 'LIMIT_EXCEEDED');
  assert.deepEqual(await it.next(), { done: true, value: undefined });
});

test('list returns a Promise whose then() gives a plain Promise', () => {
  const p = buildKvStore(fakeBase().base, KVError).list('s', {});
  assert.ok(p instanceof Promise);
  assert.equal(Object.getPrototypeOf(p.then(() => {})), Promise.prototype);
});
