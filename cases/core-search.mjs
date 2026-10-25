// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/search: filters, where across pages, the key pattern and the option rules.
import { allKeys, assertSameSet, coreCase, expectValidation, fill, names } from './core-util.mjs';

const SEARCH = { needs: ['search'] };

async function needsFilter(ctx) {
  await expectValidation(ctx, [() => ctx.kv.search({}), () => ctx.kv.search({ limit: 5 })], 'search filter');
}

async function whereAcrossPages({ kv, uniqueKey }) {
  const keys = names(`${uniqueKey('w')}-`, 60);
  const match = new Set([keys[0], keys[30], keys[59]]);
  await fill(kv, keys, (key) => ({ status: match.has(key) ? 'open' : 'closed', n: 1 }));
  const found = await allKeys(kv.search({ where: { status: 'open' }, limit: 10 }));
  assertSameSet(found, [...match], 'exactly the matching keys');
}

async function pattern({ kv, uniqueKey }) {
  const u = uniqueKey('u');
  const yes = [`${u}:1:x`, `${u}::x`, `${u}:long:id:x`, `${u}:q?.x`];
  const no = [`${u}:1:y`, `${u}:1:xy`, `v${u}:1:x`];
  await fill(kv, [...yes, ...no]);
  assertSameSet(await allKeys(kv.search({ pattern: `${u}:*:x` })), yes.slice(0, 3), '* matches zero or more characters');
  assertSameSet(await allKeys(kv.search({ pattern: `${u}:q?.x` })), [`${u}:q?.x`], '? and . are literal');
  assertSameSet(await allKeys(kv.search({ pattern: `${u}:1?x` })), [], '? is not a wildcard');
  assertSameSet(await allKeys(kv.search({ pattern: `${u}:1.x` })), [], '. is not a wildcard');
}

async function indexRefused(ctx) {
  await expectValidation(ctx, [
    () => ctx.kv.search({ index: 'byStatus' }),
    () => ctx.kv.search({ prefix: 'a', equals: { a: 1 } }),
  ], 'index on search');
}

async function whereBounds(ctx) {
  const nine = Object.fromEntries(Array.from({ length: ctx.limits.whereFields.max + 1 }, (_, i) => [`f${i}`, i]));
  await expectValidation(ctx, [
    () => ctx.kv.search({ where: nine }),
    () => ctx.kv.search({ where: {} }),
    () => ctx.kv.search({ where: { a: { b: 1 } } }),
    () => ctx.kv.search({ where: { a: [1] } }),
  ], 'where');
}

async function encryptedWhere(ctx) {
  await expectValidation(ctx, [() => ctx.kv.search({ where: { a: 1 }, type: 'encrypted' })], 'encrypted where');
}

export const coreSearchCases = [
  coreCase('search/needs-filter', needsFilter, SEARCH),
  coreCase('search/where-across-pages', whereAcrossPages, SEARCH),
  coreCase('search/pattern', pattern, SEARCH),
  coreCase('search/index-refused', indexRefused, SEARCH),
  coreCase('search/where-bounds', whereBounds, SEARCH),
  coreCase('search/encrypted-where', encryptedWhere, SEARCH),
];
