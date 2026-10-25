// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../run.mjs';
import { cases } from '../cases/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fake = join(root, 'test/fixtures/fake-adapter.mjs');
const exec = (...args) => spawnSync(process.execPath, [join(root, 'run.mjs'), ...args], { encoding: 'utf8', cwd: root });

test('exit 0 with one line per result', () => {
  // The fake adapter has no store behaviour: leave out the core and ledger cases that need one.
  const r = exec('--adapter', fake, '--exclude', 'core/', '--exclude', 'ledger/',
    '--exclude', 'proof/', '--exclude', 'subject-v1/');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('PASS'));
  assert.equal(lines.length, cases.filter((c) => c.tags.includes('bytes')).length);
  assert.match(r.stdout, /pass/);
});

test('--json writes the report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kvc-'));
  try {
    const file = join(dir, 'report.json');
    const r = exec('--adapter', fake, '--json', file, '--exclude', 'core/', '--exclude', 'ledger/',
    '--exclude', 'proof/', '--exclude', 'subject-v1/');
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(report.suite, 'kv-conformance');
    assert.equal(report.adapter, null);
    assert.deepEqual(report.tags, ['bytes', 'core', 'ledger']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--list prints names and tags without running or needing an adapter', () => {
  const r = exec('--list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^bytes\/\S+\s+bytes$/m);
});

test('exit 2 for bad input', async () => {
  assert.equal(exec('--adapter', fake, '--bogus').status, 2);
  assert.equal(exec('--adapter', fake, '--tags', 'nonsense').status, 2);
  const core = [{ name: 'core/a', tags: ['core'], needs: [], run: async () => {} }];
  for (const f of ['missing.mjs', 'no-adapter.mjs', 'throwing-adapter.mjs']) {
    const code = await main(['--adapter', join(root, 'test/fixtures', f)], { cases: core, stdout: () => {}, stderr: () => {} });
    assert.equal(code, 2, f);
  }
});

test('exit 1 when a case fails (cases injected into main)', async () => {
  const out = [];
  const failing = [{ name: 'core/bad', tags: ['core'], needs: [], run: async () => { throw new Error('boom'); } }];
  const code = await main(['--adapter', fake], { cases: failing, stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(out.join(''), /FAIL\s+core\/bad.*boom/);
});

test('skip lines carry the reason', async () => {
  const out = [];
  const skipped = [{ name: 'core/s', tags: ['core'], needs: ['search'], run: async () => {} }];
  const code = await main(['--adapter', fake], { cases: skipped, stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 0);
  assert.match(out.join(''), /SKIP\s+core\/s.*needs search/);
});

test('--help prints usage and exits 0', () => {
  const r = exec('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: node run.mjs/);
});

test('--tags bytes works without --adapter; adapter cases without one exit 2', async () => {
  const r = exec('--tags', 'bytes');
  assert.equal(r.status, 0, r.stderr);
  const err = [];
  const core = [{ name: 'core/a', tags: ['core'], needs: [], run: async () => {} }];
  const code = await main([], { cases: core, stdout: () => {}, stderr: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join(''), /adapter is required/);
});

test('--include and --exclude filter by name prefix', () => {
  const inc = exec('--adapter', fake, '--include', 'bytes/definition');
  assert.equal(inc.status, 0, inc.stderr);
  const lines = inc.stdout.split('\n').filter((l) => l.startsWith('PASS'));
  assert.ok(lines.length > 0 && lines.every((l) => l.includes('bytes/definition')));
  const exc = exec('--adapter', fake, '--exclude', 'bytes/', '--exclude', 'core/', '--exclude', 'ledger/',
    '--exclude', 'proof/', '--exclude', 'subject-v1/');
  assert.equal(exc.status, 0, exc.stderr);
  assert.ok(!exc.stdout.includes('PASS'));
  assert.match(exc.stdout, /0 total/);
});

test('--timeout-ms sets the run timeout; a bad value exits 2', async () => {
  const out = [];
  const hang = [{ name: 'core/h', tags: ['core'], needs: [], shapes: ['global'], run: () => new Promise(() => {}) }];
  const code = await main(['--adapter', fake, '--timeout-ms', '20'], { cases: hang, stdout: (s) => out.push(s), stderr: () => {} });
  assert.equal(code, 1);
  assert.match(out.join(''), /FAIL\s+core\/h.*timeout after 20 ms/);
  for (const bad of ['0', '-5', 'abc', '1.5']) {
    assert.equal(await main(['--adapter', fake, '--timeout-ms', bad], { cases: hang, stdout: () => {}, stderr: () => {} }), 2, bad);
  }
});
