// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, EXPIRY_HINT } from '../lib/limits.mjs';

function deepFrozen(v) {
  if (v === null || typeof v !== 'object' || v instanceof RegExp) return true;
  return Object.isFrozen(v) && Object.values(v).every(deepFrozen);
}

test('LIMITS is deep-frozen', () => {
  assert.ok(deepFrozen(LIMITS));
});

test('numeric limits match the contract', () => {
  assert.equal(LIMITS.keyMaxBytes, 2048);
  assert.equal(LIMITS.idMaxBytes, 1000);
  assert.equal(LIMITS.itemMaxBytes, 409600);
  assert.deepEqual({ ...LIMITS.ttl }, { min: 60, max: 31536000 });
  assert.deepEqual({ ...LIMITS.getMany }, { minKeys: 1, maxKeys: 100, maxBytes: 4 * 1024 * 1024 });
  assert.deepEqual({ ...LIMITS.transaction }, { minOps: 1, maxOps: 25 });
  assert.deepEqual({ ...LIMITS.listLimit }, { min: 1, max: 1000, default: 25 });
  assert.equal(LIMITS.pageBytesEdge, 4194304);
  assert.equal(LIMITS.pageBytesBudget, 4000000);
  assert.equal(LIMITS.scannedRowsPerPage, 10000);
  assert.deepEqual([...LIMITS.pageEnd], ['limit', 'bytes', 'budget', 'end']);
  assert.deepEqual({ ...LIMITS.maxPages }, { min: 1, max: 100, default: 10 });
  assert.equal(LIMITS.verifyChainMaxEntries, 10000);
  assert.deepEqual({ ...LIMITS.prefixPattern }, { min: 1, max: 512 });
  assert.deepEqual({ ...LIMITS.whereFields }, { min: 1, max: 8 });
  assert.deepEqual({ ...LIMITS.equalsFields }, { max: 3 });
  assert.equal(LIMITS.fieldStringMaxChars, 512);
  assert.equal(LIMITS.cursorLifetimeMs, 86400000);
  assert.equal(LIMITS.ledgerCollectionMaxBytes, 512);
  assert.equal(LIMITS.ledgerValueMaxBytes, 350000);
  assert.deepEqual({ ...LIMITS.ledgerChains }, { min: 1, max: 64 });
  assert.equal(LIMITS.ledgerActivationMs, 75000);
  assert.equal(LIMITS.activationMarginMs, 15000);
  assert.equal(LIMITS.shortPagesBudgetMax, 10);
  assert.deepEqual({ ...LIMITS.ledgerRetentionDays }, { min: 1, max: 36500 });
  assert.equal(LIMITS.ledgerPersonalFieldsMax, 20);
  assert.equal(LIMITS.ledgersPerStore, 20);
  assert.equal(LIMITS.ledgerSubjectMaxBytes, 256);
  assert.equal(LIMITS.idempotencyKey.maxLength, 64);
  assert.deepEqual({ ...LIMITS.indexFields }, { min: 0, max: 3 });
  assert.equal(LIMITS.indexesPerStore, 20);
  assert.equal(LIMITS.indexesPerCollection, 5);
  assert.equal(LIMITS.indexActivationMs, 75000);
  assert.equal(LIMITS.archivePeriodMs, 300000);
  assert.equal(LIMITS.archiveDelayMs, 60000);
  assert.equal(LIMITS.archiveObjectMaxEntries, 10000);
  assert.deepEqual({ ...LIMITS.timeoutsMs }, { default: 8000, append: 11000 });
});

test('patterns accept and refuse the right names', () => {
  assert.ok(LIMITS.storeId.test('my_store-1'));
  assert.ok(!LIMITS.storeId.test('bad store'));
  assert.ok(!LIMITS.storeId.test('a'.repeat(256)));
  assert.ok(LIMITS.ledgerName.test('aiUse_1'));
  assert.ok(!LIMITS.ledgerName.test('1abc'));
  assert.ok(!LIMITS.ledgerName.test('a'.repeat(65)));
  assert.equal(LIMITS.indexName, LIMITS.ledgerName);
  assert.ok(LIMITS.idempotencyKey.pattern.test('abc_DEF-9'));
  assert.ok(!LIMITS.idempotencyKey.pattern.test('a'.repeat(65)));
  assert.equal(LIMITS.idempotencyKey.replayWindowMs, 86400000);
  assert.ok(LIMITS.idempotencyKey.autoPattern.test('q_' + 'a0'.repeat(16)));
  assert.ok(!LIMITS.idempotencyKey.autoPattern.test('q_xyz'));
});

test('where/equals field names', () => {
  assert.ok(LIMITS.fieldName.test('_status1'));
  assert.ok(LIMITS.fieldName.test('a'.repeat(64)));
  assert.ok(!LIMITS.fieldName.test('a'.repeat(65)));
  assert.ok(!LIMITS.fieldName.test('1a'));
  assert.ok(!LIMITS.fieldName.test('a-b'));
  assert.deepEqual([...LIMITS.reservedFieldNames], ['__proto__', 'constructor', 'prototype']);
});

test('expiry option names and hint', () => {
  assert.deepEqual([...LIMITS.expiryOptionNames], ['expiration', 'expirationTtl', 'expires', 'expiresAt', 'expiresIn', 'ttlSeconds', 'maxAge']);
  assert.equal(EXPIRY_HINT, 'use ttl (seconds)');
});
