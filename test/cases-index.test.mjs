// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases, assertUniqueNames } from '../cases/index.mjs';
import * as api from '../index.mjs';

test('cases aggregate the bytes cases with unique names', () => {
  assert.ok(cases.some((c) => c.name.startsWith('bytes/')));
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
});

test('a duplicate name throws', () => {
  assert.throws(() => assertUniqueNames([{ name: 'a' }, { name: 'a' }]), /duplicate.*a/i);
});

test('index exports the public surface', () => {
  for (const k of ['run', 'cases', 'SUITE_VERSION', 'VALIDATED_AGAINST', 'LIMITS', 'ERROR_CODES', 'createVirtualClock',
    'createRealClock', 'buildKvStore', 'createEdgeCalls', 'createEdgeChecks', 'createKVErrorClass', 'ledgerBytes',
  ]) assert.ok(api[k] !== undefined, k);
  assert.equal(typeof api.ledgerBytes.canonicalJson, 'function');
});
