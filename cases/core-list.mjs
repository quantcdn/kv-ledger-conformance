// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/list: prefix lists, values, limits, option rules and cursors.
import assert from 'node:assert/strict';
import { allKeys, allPages, assertSameSet, coreCase, expectValidation, fill, names } from './core-util.mjs';

async function prefix({ kv, uniqueKey }) {
  const p = uniqueKey('p');
  const inside = [`${p}:a`, `${p}:b`, `${p}x`];
  await fill(kv, [...inside, `other-${p}`, `q${p}`]);
  assertSameSet(await allKeys(kv.list({ prefix: p })), inside, 'prefix');
}

async function seed(kv, uniqueKey) {
  const p = uniqueKey('v');
  await fill(kv, [`${p}-1`, `${p}-2`], (key, i) => ({ i }));
  return p;
}

async function valuesOff({ kv, uniqueKey }) {
  const p = await seed(kv, uniqueKey);
  const page = await kv.list({ prefix: p });
  assert.equal(page.items.length, 2);
  for (const item of page.items) assert.ok(!('value' in item), `no value for ${item.key}`);
}

async function valuesOn({ kv, uniqueKey }) {
  const p = await seed(kv, uniqueKey);
  const items = (await allPages(kv.list({ prefix: p, includeValues: true }))).flatMap((page) => page.items);
  assert.equal(items.length, 2);
  for (const item of items) assert.deepEqual(item.value, { i: Number(item.key.endsWith('2')) });
  for (const item of items) assert.equal(item.encrypted, false);
}

async function limitBounds(ctx) {
  const { min, max } = ctx.limits.listLimit;
  await expectValidation(ctx, [min - 1, max + 1, min + 1.5].map((limit) => () => ctx.kv.list({ limit })), 'limit');
  for (const limit of [min, max]) assert.ok(Array.isArray((await ctx.kv.list({ limit })).items), `limit ${limit}`);
}

async function unknownOption(ctx) {
  await expectValidation(ctx, [() => ctx.kv.list({ bogus: 1 })], 'list option');
}

async function prefixAndPattern(ctx) {
  await expectValidation(ctx, [() => ctx.kv.list({ prefix: 'a', pattern: 'a*' })], 'prefix and pattern');
}

async function prefixLength(ctx) {
  const long = 'p'.repeat(ctx.limits.prefixPattern.max + 1);
  await expectValidation(ctx, [() => ctx.kv.list({ prefix: long }), () => ctx.kv.list({ prefix: '' })], 'prefix');
}

const WALK = { keys: 60, limit: 7 };

async function walkKeys(kv, uniqueKey) {
  const p = uniqueKey('w');
  const keys = names(`${p}-`, WALK.keys);
  await fill(kv, keys);
  return { p, keys };
}

async function cursorWalk({ kv, uniqueKey }) {
  const { p, keys } = await walkKeys(kv, uniqueKey);
  const pages = await allPages(kv.list({ prefix: p, limit: WALK.limit }));
  assertSameSet(pages.flatMap((page) => page.items.map((i) => i.key)), keys, 'every key once');
  const last = pages[pages.length - 1];
  assert.equal(last.hasMore, false);
  assert.equal(last.cursor, null);
  for (const page of pages.slice(0, -1)) assert.equal(typeof page.cursor, 'string');
}

async function pageEndValues({ kv, uniqueKey, limits }) {
  const { p } = await walkKeys(kv, uniqueKey);
  for (const page of await allPages(kv.list({ prefix: p, limit: WALK.limit }))) {
    const ok = page.pageEnd === undefined || limits.pageEnd.includes(page.pageEnd);
    assert.ok(ok, `pageEnd ${page.pageEnd}`);
  }
}

// The cursor of a page that has more after it.
async function cursorOf(kv, options) {
  const page = await kv.list({ ...options, limit: 1 });
  assert.equal(typeof page.cursor, 'string', 'the first page has a cursor');
  return page.cursor;
}

const INVALID = { code: 'CURSOR_INVALID', retryable: false };

function tamper(cursor) {
  const at = Math.floor(cursor.length / 2);
  const swap = cursor[at] === 'A' ? 'B' : 'A';
  return cursor.slice(0, at) + swap + cursor.slice(at + 1);
}

async function cursorTampered(ctx) {
  const p = await seed(ctx.kv, ctx.uniqueKey);
  const cursor = await cursorOf(ctx.kv, { prefix: p });
  await ctx.expectKVError(() => ctx.kv.list({ prefix: p, cursor: tamper(cursor) }), INVALID);
  await ctx.expectKVError(() => ctx.kv.list({ prefix: p, cursor: 'not-a-cursor' }), INVALID);
}

async function cursorOtherQuery(ctx) {
  const [a, b] = [await seed(ctx.kv, ctx.uniqueKey), await seed(ctx.kv, ctx.uniqueKey)];
  const cursor = await cursorOf(ctx.kv, { prefix: a });
  await ctx.expectKVError(() => ctx.kv.list({ prefix: b, cursor }), INVALID);
}

async function cursorExpired(ctx) {
  const p = await seed(ctx.kv, ctx.uniqueKey);
  const cursor = await cursorOf(ctx.kv, { prefix: p });
  await ctx.clock.advance(ctx.limits.cursorLifetimeMs + 1000);
  await ctx.expectKVError(() => ctx.kv.list({ prefix: p, cursor }), INVALID);
}

export const coreListCases = [
  coreCase('list/prefix', prefix),
  coreCase('list/values-off', valuesOff),
  coreCase('list/values-on', valuesOn),
  coreCase('list/limit-bounds', limitBounds),
  coreCase('list/unknown-option', unknownOption),
  coreCase('list/prefix-and-pattern', prefixAndPattern),
  coreCase('list/prefix-length', prefixLength),
  coreCase('list/cursor-walk', cursorWalk),
  coreCase('list/page-end-values', pageEndValues),
  coreCase('list/cursor-tampered', cursorTampered),
  coreCase('list/cursor-other-query', cursorOtherQuery),
  coreCase('list/cursor-expired', cursorExpired, { needs: ['virtualClock'] }),
];
