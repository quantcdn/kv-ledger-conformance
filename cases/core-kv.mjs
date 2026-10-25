// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/kv: get, set, delete, getEntry and getMany.
import assert from 'node:assert/strict';
import { coreCase, expectValidation } from './core-util.mjs';

async function getMissingNull({ kv, uniqueKey }) {
  assert.equal(await kv.get(uniqueKey('missing')), null, 'get of a missing key is null');
}

async function setPlainTrue({ kv, uniqueKey }) {
  assert.equal(await kv.set(uniqueKey('plain'), { a: 1 }), true);
}

const JSON_VALUES = [{ a: 1, b: { c: [1, 2] } }, [1, 'two', null], 42, -3.5, true, false];

async function jsonRoundTrip({ kv, uniqueKey }) {
  for (const value of JSON_VALUES) {
    const key = uniqueKey('json');
    await kv.set(key, value);
    assert.deepEqual(await kv.get(key), value, JSON.stringify(value));
  }
}

async function stringValue({ kv, uniqueKey }) {
  const key = uniqueKey('str');
  await kv.set(key, 'hello "world"');
  assert.equal(await kv.get(key), 'hello "world"');
}

async function rawGet({ kv, kvStore, storeId, shape, uniqueKey }) {
  const key = uniqueKey('raw');
  const value = { a: [1, 2], b: 'x' };
  await kv.set(key, value);
  const text = await kv.get(key, { raw: true });
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), value);
  const other = shape === 'handle' ? await kv.get(key, true) : await kvStore.get(storeId, key, true);
  assert.equal(typeof other, 'string');
  assert.deepEqual(JSON.parse(other), value);
}

async function getOptions(ctx) {
  const key = ctx.uniqueKey('opt');
  await ctx.kv.set(key, 1);
  await expectValidation(ctx, [() => ctx.kv.get(key, { bogus: 1 }), () => ctx.kv.get(key, { raw: 'yes' })], 'get options');
}

async function deleteTrueThenNull({ kv, uniqueKey }) {
  const key = uniqueKey('del');
  await kv.set(key, 1);
  assert.equal(await kv.delete(key), true);
  assert.equal(await kv.get(key), null);
}

async function getEntryShape({ kv, uniqueKey }) {
  const key = uniqueKey('entry');
  await kv.set(key, { n: 1 });
  const entry = await kv.getEntry(key);
  assert.equal(entry.key, key);
  assert.deepEqual(entry.value, { n: 1 });
  assert.equal(typeof entry.version, 'string');
  assert.ok(entry.version.length > 0, 'version is not empty');
  assert.equal(await kv.getEntry(uniqueKey('missing')), null);
}

async function versionChanges({ kv, uniqueKey }) {
  const key = uniqueKey('ver');
  await kv.set(key, 1);
  const first = (await kv.getEntry(key)).version;
  await kv.set(key, 1);
  const second = (await kv.getEntry(key)).version;
  assert.notEqual(first, second, 'every write gives a new version');
}

async function getManyOrder({ kv, uniqueKey }) {
  const [a, b, missing] = [uniqueKey('a'), uniqueKey('b'), uniqueKey('m')];
  await kv.set(a, 'A');
  await kv.set(b, 'B');
  const result = await kv.getMany([b, missing, a]);
  assert.equal(result.length, 3, 'getMany: one result per key');
  assert.equal(result[0].key, b, 'getMany order: result 0 is the first key');
  assert.equal(result[0].value, 'B', 'getMany order: value 0');
  assert.equal(result[1], null, 'getMany order: a missing key is null in its place');
  assert.equal(result[2].key, a);
  assert.equal(result[2].value, 'A');
}

async function getManyBounds(ctx) {
  const tooMany = Array.from({ length: ctx.limits.getMany.maxKeys + 1 }, (_, i) => `k${i}`);
  await expectValidation(ctx, [
    () => ctx.kv.getMany([]),
    () => ctx.kv.getMany(tooMany),
    () => ctx.kv.getMany(['a', 123]),
    () => ctx.kv.getMany(['a', '']),
  ], 'getMany');
}

export const coreKvCases = [
  coreCase('kv/get-missing-null', getMissingNull),
  coreCase('kv/set-plain-true', setPlainTrue),
  coreCase('kv/json-round-trip', jsonRoundTrip),
  coreCase('kv/string-value', stringValue),
  coreCase('kv/raw-get', rawGet),
  coreCase('kv/get-options', getOptions, { shapes: ['handle'] }),
  coreCase('kv/delete-true-then-null', deleteTrueThenNull),
  coreCase('kv/getEntry-shape', getEntryShape),
  coreCase('kv/version-changes', versionChanges),
  coreCase('kv/getMany-order', getManyOrder),
  coreCase('kv/getMany-bounds', getManyBounds),
];
