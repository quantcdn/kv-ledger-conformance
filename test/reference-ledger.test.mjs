// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The reference adapter passes every ledger case.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../lib/runner.mjs';
import { cases } from '../cases/index.mjs';
import * as reference from '../adapters/reference/index.mjs';

const failing = (report) => report.results
  .filter((r) => r.status === 'fail' || r.status === 'error')
  .map((r) => `${r.name} [${r.shape}] ${r.status}: ${r.reason}`);

test('reference adapter passes the ledger cases', { timeout: 600000 }, async () => {
  const report = await run({ adapter: reference, tags: ['ledger'], timeoutMs: 120000 });
  const bad = failing(report);
  assert.equal(bad.length, 0, `failing cases:\n${bad.join('\n')}`);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.error, 0);
  const ledgerCount = cases.filter((c) => c.tags.includes('ledger')).length;
  const skipped = report.results.filter((r) => r.status === 'skip' && r.name.startsWith('ledger/')).map((r) => r.name);
  assert.deepEqual(skipped, [], 'no ledger case skipped');
  assert.equal(report.summary.pass, ledgerCount * 2, 'every ledger case passes in both shapes');
});
