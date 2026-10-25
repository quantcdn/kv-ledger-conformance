// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ERROR_CODES, DETAIL_FIELDS } from '../lib/error-contract.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/kvstore-error-codes.json', import.meta.url), 'utf8'));

test('every code of the fixture has a row, and there are no extras', () => {
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), [...fixture.codes].sort());
});

test('DETAIL_FIELDS equals the fixture list', () => {
  assert.deepEqual([...DETAIL_FIELDS], fixture.detailFields);
});

test('rows are frozen and well-formed', () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
  for (const row of Object.values(ERROR_CODES)) {
    assert.ok(Object.isFrozen(row));
    assert.ok(row.status === null || Number.isInteger(row.status));
    assert.ok([true, false, 'varies'].includes(row.retryable));
    for (const d of row.details) assert.ok(DETAIL_FIELDS.includes(d), d);
  }
});

test('selected rows', () => {
  assert.deepEqual({ status: ERROR_CODES.CONFLICT.status, retryable: ERROR_CODES.CONFLICT.retryable }, { status: 409, retryable: false });
  assert.deepEqual([...ERROR_CODES.CONFLICT.details], ['key', 'currentVersion', 'reason', 'operation']);
  assert.equal(ERROR_CODES.UNAVAILABLE.retryable, 'varies');
  assert.equal(ERROR_CODES.VALIDATION.status, 400);
  assert.equal(ERROR_CODES.INTERNAL.status, null);
  assert.deepEqual([...ERROR_CODES.LEDGER_RETAINED.details], ['retainUntil', 'reason', 'collection', 'shard']);
  assert.equal(ERROR_CODES.LEDGER_NOT_READY.retryable, true);
  assert.equal(ERROR_CODES.CONTENTION.retryable, true);
});

test('the contract has 37 codes; LEDGER_FORMAT_RETIRED is 409 and not retryable', () => {
  assert.equal(fixture.codes.length, 37);
  assert.equal(Object.keys(ERROR_CODES).length, 37);
  assert.deepEqual({ ...ERROR_CODES.LEDGER_FORMAT_RETIRED, details: [...ERROR_CODES.LEDGER_FORMAT_RETIRED.details] },
    { status: 409, retryable: false, details: [] });
});
