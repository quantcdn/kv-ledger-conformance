// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// expectKVError: check a thrown KVError against the error contract (spec 6.2). Never checks message text
// unless expected.message is given (message-exact cases only).
import assert from 'node:assert/strict';
import { DETAIL_FIELDS, ERROR_CODES } from './error-contract.mjs';

async function capture(target) {
  try {
    await (typeof target === 'function' ? target() : target);
  } catch (err) {
    return err;
  }
  return assert.fail('expected a KVError, but the call succeeded');
}

function checkIdentity(kvStore, err) {
  assert.ok(err instanceof kvStore.KVError, `expected an instance of kvStore.KVError, got ${err && err.name}`);
  assert.equal(err.name, 'KVError', 'name: expected KVError');
}

function checkCode(err, expected) {
  const allowed = [].concat(expected.code);
  assert.ok(allowed.includes(err.code), `code: expected ${allowed.join(' or ')}, actual ${err.code}`);
}

// retryable is a boolean for every code, also for a 'varies' code and for a code outside the contract.
function checkRetryable(err, expected, contract) {
  assert.equal(typeof err.retryable, 'boolean', `retryable: expected a boolean, actual ${typeof err.retryable}`);
  const want = expected.retryable !== undefined ? expected.retryable : contract && contract.retryable;
  if (typeof want !== 'boolean') return;
  assert.equal(err.retryable, want, `retryable: expected ${want}, actual ${err.retryable}`);
}

function checkStatus(err, expected, contract) {
  const want = expected.status !== undefined ? expected.status : contract && contract.status;
  if (want === null || want === undefined) return;
  if (expected.status === undefined && err.status === undefined) return;
  assert.equal(err.status, want, `status: expected ${want}, actual ${err.status}`);
}

const TYPE_WORDS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  present: (v) => v !== undefined,
};

function detailMatches(want, actual) {
  if (want instanceof RegExp) return actual !== undefined && want.test(String(actual));
  if (typeof want === 'string' && TYPE_WORDS[want]) return TYPE_WORDS[want](actual);
  return actual === want;
}

function checkDetails(err, expected) {
  for (const [field, want] of Object.entries(expected.details || {})) {
    assert.ok(detailMatches(want, err[field]), `details.${field}: expected ${String(want)}, actual ${String(err[field])}`);
  }
}

function checkScalars(err) {
  for (const field of DETAIL_FIELDS) {
    const v = err[field];
    const ok = v === undefined || typeof v === 'string' || typeof v === 'number';
    assert.ok(ok, `${field}: detail fields must be scalar (string or number), got ${typeof v}`);
  }
}

function checkMessage(err, expected) {
  if (expected.message === undefined) return;
  const want = expected.message;
  const ok = want instanceof RegExp ? want.test(err.message) : err.message === want;
  assert.ok(ok, `message: expected ${String(want)}, actual ${err.message}`);
}

export async function expectKVError(kvStore, target, expected = {}) {
  const err = await capture(target);
  checkIdentity(kvStore, err);
  checkCode(err, expected);
  const contract = ERROR_CODES[err.code];
  checkRetryable(err, expected, contract);
  checkStatus(err, expected, contract);
  checkDetails(err, expected);
  checkScalars(err);
  checkMessage(err, expected);
  return err;
}
