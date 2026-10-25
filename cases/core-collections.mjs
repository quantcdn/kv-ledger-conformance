// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/collections: format 2 collection lists in UTF-8 byte order of the id.
import assert from 'node:assert/strict';
import { allKeys, coreCase, expectValidation, fill, names, sortBytes } from './core-util.mjs';

const PAGE = 7;
// Ids whose UTF-8 byte order differs from UTF-16 code-unit order (U+FF5E sorts before an astral character in
// UTF-8 bytes, after it in UTF-16 units), plus mixed case and digits.
const SPECIAL_IDS = ['～', '\u{1F600}', 'Zed', 'apple', '0zero', 'été'];

const idsOf = (keys, collection) => keys.map((key) => key.slice(collection.length + 1));

// A collection with 60 ids: 54 numbered ids plus the special ones. Returns { collection, ids } (byte order).
async function seedCollection({ kv, uniqueKey }) {
  const collection = `${uniqueKey('c')}:items`;
  const ids = [...names('id', 54), ...SPECIAL_IDS];
  await fill(kv, ids.map((id) => `${collection}:${id}`));
  return { collection, ids: sortBytes(ids) };
}

async function ascending(ctx) {
  const { collection, ids } = await seedCollection(ctx);
  const keys = await allKeys(ctx.kv.list({ collection, limit: PAGE }));
  assert.deepEqual(idsOf(keys, collection), ids);
}

async function reverse(ctx) {
  const { collection, ids } = await seedCollection(ctx);
  const keys = await allKeys(ctx.kv.list({ collection, limit: PAGE, reverse: true }));
  assert.deepEqual(idsOf(keys, collection), [...ids].reverse());
}

async function startsWith(ctx) {
  const { collection, ids } = await seedCollection(ctx);
  const keys = await allKeys(ctx.kv.list({ collection, startsWith: 'id01', limit: PAGE }));
  assert.deepEqual(idsOf(keys, collection), ids.filter((id) => id.startsWith('id01')));
}

async function afterBefore(ctx) {
  const { collection, ids } = await seedCollection(ctx);
  const keys = await allKeys(ctx.kv.list({ collection, after: 'id010', before: 'id020', limit: PAGE }));
  assert.deepEqual(idsOf(keys, collection), ids.filter((id) => id > 'id010' && id < 'id020'));
}

async function nestedExcluded({ kv, uniqueKey }) {
  const a = uniqueKey('a');
  await fill(kv, [`${a}:x`, `${a}:b:c`, `${a}:y`, `${a}x:z`]);
  assert.deepEqual(await allKeys(kv.list({ collection: a })), [`${a}:x`, `${a}:y`]);
}

async function rootCollection({ kv, uniqueKey }) {
  const [r1, r2] = sortBytes([uniqueKey('root'), uniqueKey('root')]);
  await fill(kv, [r1, `${r1}:child`, r2, `${uniqueKey('c')}:x`]);
  assert.deepEqual(await allKeys(kv.list({ collection: '' })), [r1, r2]);
}

async function ruleViolations(ctx) {
  const collection = ctx.uniqueKey('c');
  const list = (options) => () => ctx.kv.list({ collection, ...options });
  await expectValidation(ctx, [
    list({ startsWith: 'a', after: 'b' }),
    list({ after: 'a:b' }),
    list({ before: 'a:b' }),
    list({ startsWith: 'a:b' }),
    list({ after: 'm', before: 'c' }),
    list({ after: 'm', before: 'm' }),
    list({ prefix: 'x' }),
  ], 'collection rules');
}

async function windowWithoutCollection(ctx) {
  await expectValidation(ctx, [
    () => ctx.kv.list({ since: 0 }),
    () => ctx.kv.list({ until: Date.UTC(2030, 0, 1) }),
  ], 'window');
}

export const coreCollectionCases = [
  coreCase('collections/ascending', ascending),
  coreCase('collections/reverse', reverse),
  coreCase('collections/startsWith', startsWith),
  coreCase('collections/after-before', afterBefore),
  coreCase('collections/nested-excluded', nestedExcluded),
  coreCase('collections/root-collection', rootCollection),
  coreCase('collections/rule-violations', ruleViolations),
  coreCase('collections/window-without-collection', windowWithoutCollection),
];
