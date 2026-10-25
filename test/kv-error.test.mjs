// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKVErrorClass, isKVErrorLike } from '../lib/kv-error.mjs';

test('creates a fresh class each call', () => {
  assert.notEqual(createKVErrorClass(), createKVErrorClass());
});

test('instance shape', () => {
  const KVError = createKVErrorClass();
  const e = new KVError('CONFLICT', 'nope', { status: 409, key: 'k', currentVersion: 'v1' });
  assert.ok(e instanceof Error && e instanceof KVError);
  assert.equal(e.name, 'KVError');
  assert.equal(e.code, 'CONFLICT');
  assert.equal(e.message, 'nope');
  assert.equal(e.status, 409);
  assert.equal(e.retryable, false);
  assert.equal(e.key, 'k');
  assert.equal(e.currentVersion, 'v1');
});

test('retryable can be set; unknown and non-scalar details are dropped', () => {
  const KVError = createKVErrorClass();
  const e = new KVError('CONTENTION', 'busy', { retryable: true, retryAfter: 3, extra: 'x', index: { a: 1 }, shard: 4 });
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfter, 3);
  assert.equal(e.shard, 4);
  assert.ok(!('extra' in e));
  assert.ok(!('index' in e));
  assert.ok(!('status' in e));
});

test('constructor works without options', () => {
  const KVError = createKVErrorClass();
  assert.equal(new KVError('NOT_FOUND', 'm').retryable, false);
});

test('isKVErrorLike', () => {
  const KVError = createKVErrorClass();
  assert.ok(isKVErrorLike(new KVError('VALIDATION', 'm')));
  assert.ok(isKVErrorLike({ name: 'KVError', code: 'X' }));
  assert.ok(!isKVErrorLike(new Error('x')));
  assert.ok(!isKVErrorLike(null));
  assert.ok(!isKVErrorLike('KVError'));
});

test('retryable is always a boolean: only true is true', () => {
  const KVError = createKVErrorClass();
  for (const value of ['yes', 'true', 1, null, {}, undefined]) {
    assert.equal(new KVError('UNAVAILABLE', 'm', { retryable: value }).retryable, false, String(value));
  }
  assert.equal(new KVError('UNAVAILABLE', 'm', { retryable: true }).retryable, true);
});
