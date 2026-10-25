// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The reference adapter passes every core case, with the default scan budget and with short pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from '../lib/runner.mjs';
import * as reference from '../adapters/reference/index.mjs';
import { LIMITS } from '../lib/limits.mjs';

const coreSkips = (report) => report.results
  .filter((r) => r.status === 'skip' && r.name.startsWith('core/')).map((r) => r.name);

const failing = (report) => report.results
  .filter((r) => r.status === 'fail' || r.status === 'error')
  .map((r) => `${r.name} [${r.shape}] ${r.status}: ${r.reason}`);

async function assertClean(adapter) {
  const report = await run({ adapter, tags: ['core'], timeoutMs: 120000 });
  const bad = failing(report);
  assert.equal(bad.length, 0, `failing cases:\n${bad.join('\n')}`);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.error, 0);
  assert.ok(report.summary.pass > 0, 'some cases ran');
  return report;
}

test('reference adapter passes the core cases', { timeout: 600000 }, async () => {
  const report = await assertClean(reference);
  assert.deepEqual(coreSkips(report), ['core/iteration/short-pages'], 'only the shortPages case is skipped');
});

test('reference adapter passes the core cases with short pages (budgetRows 3)', { timeout: 600000 }, async () => {
  const report = await assertClean({ createAdapter: reference.createAdapter, options: { budgetRows: 3 } });
  assert.equal(report.capabilities.shortPages, true);
  assert.deepEqual(coreSkips(report), [], 'no core case skipped');
});

test('core/iteration/short-pages passes at budget 1 and at LIMITS.shortPagesBudgetMax', { timeout: 600000 }, async () => {
  for (const budgetRows of [1, LIMITS.shortPagesBudgetMax]) {
    const adapter = { createAdapter: reference.createAdapter, options: { budgetRows } };
    const report = await run({ adapter, tags: ['core'], include: ['core/iteration/short-pages'] });
    assert.deepEqual(report.results.map((r) => r.status), ['pass', 'pass'], `budgetRows ${budgetRows}: ${failing(report)}`);
  }
});
