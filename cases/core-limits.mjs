// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/limits: key and id bytes, colon edges, item size and the page byte budget.
import assert from 'node:assert/strict';
import { allPages, assertSameSet, coreCase, expectValidation } from './core-util.mjs';

async function keyBytes(ctx) {
  const { keyMaxBytes, idMaxBytes } = ctx.limits;
  const id = 'i'.repeat(idMaxBytes - 1);
  const fits = `${'c'.repeat(keyMaxBytes - id.length - 1)}:${id}`;
  assert.equal(Buffer.byteLength(fits), keyMaxBytes);
  await expectValidation(ctx, [() => ctx.kv.set(`c${fits}`, 1), () => ctx.kv.get(`c${fits}`)], 'key bytes');
  assert.equal(await ctx.kv.set(fits, 1), true);
  assert.equal(await ctx.kv.get(fits), 1);
}

async function idBytes(ctx) {
  // Two-byte characters: the id is over the byte limit with fewer characters than the limit.
  const id = 'é'.repeat(Math.ceil((ctx.limits.idMaxBytes + 1) / 2));
  const ascii = 'i'.repeat(ctx.limits.idMaxBytes + 1);
  await expectValidation(ctx, [() => ctx.kv.set(`c:${ascii}`, 1), () => ctx.kv.set(`c:${id}`, 1), () => ctx.kv.set(ascii, 1)],
    'id bytes');
  assert.equal(await ctx.kv.set(`c:${'i'.repeat(ctx.limits.idMaxBytes)}`, 1), true);
}

async function colonEdges(ctx) {
  await expectValidation(ctx, [
    () => ctx.kv.set(':a', 1), () => ctx.kv.set('a:', 1), () => ctx.kv.get(':a'), () => ctx.kv.delete('a:'),
  ], 'colon edges');
}

async function itemSize(ctx) {
  const key = ctx.uniqueKey('big');
  const value = 'x'.repeat(ctx.limits.itemMaxBytes + 1);
  await ctx.expectKVError(() => ctx.kv.set(key, value), { code: ['LIMIT_EXCEEDED', 'VALIDATION'], retryable: false });
  assert.equal(await ctx.kv.get(key), null, 'nothing written');
}

// 20 values of VALUE_BYTES: each fits an item, all together are well over one page budget.
const VALUE_COUNT = 20;
const VALUE_BYTES = 300000;

async function pageBytes(ctx) {
  assert.ok(VALUE_BYTES < ctx.limits.itemMaxBytes && VALUE_COUNT * VALUE_BYTES > ctx.limits.pageBytesEdge);
  const p = ctx.uniqueKey('pb');
  const keys = Array.from({ length: VALUE_COUNT }, (_, i) => `${p}-${String(i).padStart(2, '0')}`);
  for (const key of keys) await ctx.kv.set(key, 'v'.repeat(VALUE_BYTES));
  const pages = await allPages(ctx.kv.list({ prefix: p, includeValues: true, limit: ctx.limits.listLimit.max }));
  const early = pages.filter((page) => page.hasMore);
  assert.ok(early.length > 0, 'more than one page');
  // A read budget (of the backing store or a scan budget) can end a page before the byte budget does.
  const ends = ['bytes', 'budget'];
  assert.ok(early.some((page) => ends.includes(page.pageEnd) && page.items.length < VALUE_COUNT),
    `a page ends with pageEnd ${ends.join(' or ')}: ${early.map((page) => page.pageEnd)}`);
  for (const page of pages.filter((pg) => pg.pageEnd === 'bytes')) assert.ok(page.items.length >= 1, 'a bytes page holds an item');
  assertSameSet(pages.flatMap((page) => page.items.map((i) => i.key)), keys, 'iteration reaches all values');
}

export const coreLimitCases = [
  coreCase('limits/key-bytes', keyBytes),
  coreCase('limits/id-bytes', idBytes),
  coreCase('limits/colon-edges', colonEdges),
  coreCase('limits/item-size', itemSize),
  coreCase('limits/page-bytes', pageBytes, { timeoutMs: 120000 }),
];
