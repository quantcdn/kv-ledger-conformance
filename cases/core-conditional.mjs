// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// core/conditional: ifAbsent and ifVersion on set, ifVersion on delete.
import assert from 'node:assert/strict';
import { coreCase, expectValidation } from './core-util.mjs';

const conflict = (details) => ({ code: 'CONFLICT', status: 409, retryable: false, details });

function assertVersionResult(result) {
  assert.equal(typeof result?.version, 'string', 'a conditional set resolves to { version }');
  assert.ok(result.version.length > 0, 'version is not empty');
}

async function ifAbsentCreate({ kv, uniqueKey }) {
  const key = uniqueKey('abs');
  const result = await kv.set(key, 1, { ifAbsent: true });
  assertVersionResult(result);
  assert.equal(result.version, (await kv.getEntry(key)).version);
}

async function ifAbsentExists(ctx) {
  const key = ctx.uniqueKey('abs');
  await ctx.kv.set(key, 1);
  await ctx.expectKVError(() => ctx.kv.set(key, 2, { ifAbsent: true }), conflict({ key, reason: 'exists' }));
  assert.equal(await ctx.kv.get(key), 1, 'the value did not change');
}

async function ifVersionMatch({ kv, uniqueKey }) {
  const key = uniqueKey('ver');
  await kv.set(key, 1);
  const { version } = await kv.getEntry(key);
  const result = await kv.set(key, 2, { ifVersion: version });
  assertVersionResult(result);
  assert.notEqual(result.version, version);
  assert.equal(await kv.get(key), 2);
}

async function ifVersionMismatch(ctx) {
  const key = ctx.uniqueKey('ver');
  await ctx.kv.set(key, 1);
  const { version: old } = await ctx.kv.getEntry(key);
  await ctx.kv.set(key, 2);
  const { version: current } = await ctx.kv.getEntry(key);
  const err = await ctx.expectKVError(() => ctx.kv.set(key, 3, { ifVersion: old }),
    conflict({ reason: 'version', currentVersion: 'string' }));
  assert.equal(err.currentVersion, current, 'currentVersion is the stored version');
  assert.equal(await ctx.kv.get(key), 2);
}

async function bothConditions(ctx) {
  const key = ctx.uniqueKey('both');
  await expectValidation(ctx, [() => ctx.kv.set(key, 1, { ifAbsent: true, ifVersion: 'v1' })], 'both');
  assert.equal(await ctx.kv.get(key), null, 'nothing written');
}

async function deleteIfVersion(ctx) {
  const key = ctx.uniqueKey('del');
  await ctx.kv.set(key, 1);
  const { version: old } = await ctx.kv.getEntry(key);
  await ctx.kv.set(key, 2);
  await ctx.expectKVError(() => ctx.kv.delete(key, { ifVersion: old }), conflict({ reason: 'version' }));
  assert.equal(await ctx.kv.get(key), 2, 'a failed delete keeps the key');
  const { version } = await ctx.kv.getEntry(key);
  assert.equal(await ctx.kv.delete(key, { ifVersion: version }), true);
  assert.equal(await ctx.kv.get(key), null);
}

// The platform gives each version as a ULID: 26 characters of Crockford base32. Clients can check for it.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function versionShape({ kv, uniqueKey }) {
  const key = uniqueKey('shape');
  const set = await kv.set(key, 1, { ifAbsent: true });
  assert.match(set.version, ULID, 'set { ifAbsent } version is a ULID');
  assert.match((await kv.getEntry(key)).version, ULID, 'getEntry version is a ULID');
  const other = uniqueKey('shape');
  const result = await kv.atomic().set(other, 2).check(key, set.version).commit();
  assert.match(result.versions[other], ULID, 'atomic version is a ULID');
}

async function deleteIfVersionMissing(ctx) {
  const key = ctx.uniqueKey('gone');
  await ctx.kv.set(key, 1);
  const { version } = await ctx.kv.getEntry(key);
  await ctx.kv.delete(key);
  await ctx.expectKVError(() => ctx.kv.delete(key, { ifVersion: version }), conflict({ reason: 'missing' }));
}

export const coreConditionalCases = [
  coreCase('conditional/ifAbsent-create', ifAbsentCreate),
  coreCase('conditional/ifAbsent-exists', ifAbsentExists),
  coreCase('conditional/ifVersion-match', ifVersionMatch),
  coreCase('conditional/ifVersion-mismatch', ifVersionMismatch),
  coreCase('conditional/both-conditions', bothConditions),
  coreCase('conditional/delete-ifVersion', deleteIfVersion),
  coreCase('conditional/delete-ifVersion-missing', deleteIfVersionMissing),
  coreCase('conditional/version-shape', versionShape),
];
