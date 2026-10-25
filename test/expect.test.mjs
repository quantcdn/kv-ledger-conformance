// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKVErrorClass } from '../lib/kv-error.mjs';
import { expectKVError } from '../lib/expect.mjs';

const KVError = createKVErrorClass();
const kvStore = { KVError };
const make = (code, extra = {}) => Object.assign(new KVError(code, 'text'), extra);
const rejects = (err) => () => Promise.reject(err);

test('passes for the right code, retryable and status from the contract', async () => {
  await expectKVError(kvStore, rejects(make('CONFLICT', { key: 'a', currentVersion: 3 })), { code: 'CONFLICT' });
});

test('accepts a promise and an array of codes', async () => {
  const p = Promise.reject(make('CONTENTION', { retryable: true }));
  await expectKVError(kvStore, p, { code: ['CONFLICT', 'CONTENTION'] });
});

test('accepts a synchronous throw', async () => {
  await expectKVError(kvStore, () => { throw make('VALIDATION'); }, { code: 'VALIDATION' });
});

test('fails when the call succeeds', async () => {
  await assert.rejects(expectKVError(kvStore, async () => 1, { code: 'VALIDATION' }), /succeeded/);
});

test('fails for a foreign error class and names the problem', async () => {
  await assert.rejects(expectKVError(kvStore, rejects(new Error('x')), { code: 'VALIDATION' }), /KVError/);
});

test('fails for a wrong code and names expected and actual', async () => {
  const p = expectKVError(kvStore, rejects(make('FORBIDDEN')), { code: 'VALIDATION' });
  await assert.rejects(p, /code.*VALIDATION.*FORBIDDEN|VALIDATION.*FORBIDDEN/s);
});

test('checks retryable against expected and against the contract', async () => {
  await assert.rejects(expectKVError(kvStore, rejects(make('CONFLICT', { retryable: true })), { code: 'CONFLICT' }), /retryable/);
  await assert.rejects(expectKVError(kvStore, rejects(make('CONFLICT')), { code: 'CONFLICT', retryable: true }), /retryable/);
  await expectKVError(kvStore, rejects(make('UNAVAILABLE', { retryable: true })), { code: 'UNAVAILABLE' });
});

test('checks status when given and when the contract has one', async () => {
  await assert.rejects(expectKVError(kvStore, rejects(make('CONFLICT', { status: 500 })), { code: 'CONFLICT' }), /status/);
  await assert.rejects(expectKVError(kvStore, rejects(make('INTERNAL', { status: 500 })), { code: 'INTERNAL', status: 502 }), /status/);
});

test('checks detail fields: exact, type words, patterns, present', async () => {
  const err = make('CONFLICT', { key: 'k1', currentVersion: 7, reason: 'version', operation: 'set' });
  const details = { key: 'k1', currentVersion: 'number', reason: /^ver/, operation: 'present' };
  await expectKVError(kvStore, rejects(err), { code: 'CONFLICT', details });
  await assert.rejects(expectKVError(kvStore, rejects(err), { code: 'CONFLICT', details: { key: 'zz' } }), /key/);
  await assert.rejects(expectKVError(kvStore, rejects(err), { code: 'CONFLICT', details: { key: 'number' } }), /key/);
  await assert.rejects(expectKVError(kvStore, rejects(err), { code: 'CONFLICT', details: { hint: 'present' } }), /hint/);
});

test('fails when a detail field is not a scalar', async () => {
  const err = make('CONFLICT', { key: { nested: true } });
  await assert.rejects(expectKVError(kvStore, rejects(err), { code: 'CONFLICT' }), /key.*scalar|scalar.*key/s);
});

test('checks message text only when expected.message is given', async () => {
  await expectKVError(kvStore, rejects(make('VALIDATION')), { code: 'VALIDATION' });
  await expectKVError(kvStore, rejects(make('VALIDATION')), { code: 'VALIDATION', message: 'text' });
  await expectKVError(kvStore, rejects(make('VALIDATION')), { code: 'VALIDATION', message: /ex/ });
  await assert.rejects(expectKVError(kvStore, rejects(make('VALIDATION')), { code: 'VALIDATION', message: 'other' }), /message/);
});

test('message strings compare exactly, not by type word', async () => {
  const err = make('VALIDATION');
  await assert.rejects(expectKVError(kvStore, rejects(err), { code: 'VALIDATION', message: 'string' }), /message/);
});

test('retryable must be a boolean, also for a varies code and for a code outside the contract', async () => {
  const bad = (code, value) => { const e = new KVError(code, 'text'); e.retryable = value; return e; };
  await assert.rejects(expectKVError(kvStore, rejects(bad('UNAVAILABLE', undefined)), { code: 'UNAVAILABLE' }), /retryable/);
  await assert.rejects(expectKVError(kvStore, rejects(bad('UNAVAILABLE', 'yes')), { code: 'UNAVAILABLE' }), /retryable/);
  await assert.rejects(expectKVError(kvStore, rejects(bad('SOMETHING_NEW', 1)), { code: 'SOMETHING_NEW' }), /retryable/);
  await expectKVError(kvStore, rejects(bad('SOMETHING_NEW', true)), { code: 'SOMETHING_NEW' });
});
