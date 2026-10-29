// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The subject-v1 group (spec 8): listed, well-formed, passed by the reference adapter (subjectV1 true) when the group
// is selected and enabled, and never run otherwise. The vectors file holds the canonicalisation vectors as data, and
// the local backend reproduces each of them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/runner.mjs';
import { cases } from '../cases/index.mjs';
import * as reference from '../adapters/reference/index.mjs';
import { canonicalSubjectId } from '../adapters/reference/backend/subject-canonical.mjs';

const NAMES = ['declare-pseudonym', 'read-back', 'reserved', 'bad-type', 'same-subject', 'fold']
  .map((n) => `subject-v1/${n}`);
const subjectCases = cases.filter((c) => c.tags.includes('subject-v1'));

test('the subject-v1 cases are listed and well-formed', () => {
  assert.deepEqual(subjectCases.map((c) => c.name), NAMES);
  for (const c of subjectCases) {
    assert.deepEqual(c.tags, ['subject-v1'], c.name);
    assert.deepEqual(c.needs, ['subjectV1'], c.name);
    assert.equal(c.subjectContract, 1, c.name);
    assert.notEqual(c.adapter, false, c.name);
    assert.equal(typeof c.run, 'function', c.name);
  }
});

test('the CLI list shows the subject-v1 cases', () => {
  const cli = fileURLToPath(new URL('../run.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const name of NAMES) assert.ok(r.stdout.includes(`${name}\tsubject-v1\n`), name);
});

test('the reference adapter skips the subject-v1 cases by default and passes them when enabled', async () => {
  const byDefault = await run({ adapter: reference, include: ['subject-v1/'] });
  assert.equal(byDefault.results.length, NAMES.length);
  assert.ok(byDefault.results.every((r) => r.status === 'skip' && r.reason === 'tag subject-v1 not selected'));
  const enabled = await run({ adapter: reference, tags: ['subject-v1'], enable: ['subject-v1'], include: ['subject-v1/'] });
  assert.equal(enabled.results.length, NAMES.length * 2, 'each case in both shapes');
  const bad = enabled.results.filter((r) => r.status !== 'pass').map((r) => `${r.name} [${r.shape}]: ${r.reason}`);
  assert.deepEqual(bad, []);
});

test('the subject-v1 cases do not run unless enabled, even for an adapter with subjectV1', async () => {
  let created = 0;
  const withSubject = {
    async createAdapter(options) {
      created += 1;
      const adapter = await reference.createAdapter(options);
      return { ...adapter, capabilities: { ...adapter.capabilities, subjectV1: true } };
    },
  };
  const report = await run({ adapter: withSubject, tags: ['subject-v1'], include: ['subject-v1/'] });
  assert.equal(report.results.length, NAMES.length);
  assert.ok(report.results.every((r) => r.status === 'skip' && r.reason === 'subject-v1 not enabled'));
  assert.equal(created, 0, 'no adapter is made when no case can run');
});

test('the vectors file holds the spec 8 vectors', () => {
  const file = JSON.parse(readFileSync(new URL('../fixtures/subject-v1-vectors.json', import.meta.url), 'utf8'));
  assert.equal(file.subjectContract, 1);
  const find = (input, subjectCase) => file.vectors.find((v) => Object.is(v.input, input) && v.subjectCase === subjectCase);
  assert.equal(find(' Alice@Example.COM ', 'exact').canonical, 'Alice@Example.COM');
  assert.equal(find(' Alice@Example.COM ', 'fold').canonical, 'alice@example.com');
  assert.equal(find('é', 'exact').canonical, 'é');
  assert.equal(find('\uD800', 'exact').error, 'VALIDATION');
  assert.equal(find(42, 'exact').canonical, '42');
  assert.equal(find(4.5, 'exact').error, 'VALIDATION');
  for (const v of file.vectors) assert.ok((v.canonical === undefined) !== (v.error === undefined), JSON.stringify(v));
});

test('the local backend canonicalises each vector as the file says', () => {
  const file = JSON.parse(readFileSync(new URL('../fixtures/subject-v1-vectors.json', import.meta.url), 'utf8'));
  const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
  for (const v of file.vectors) {
    const label = JSON.stringify(v);
    if (v.error === undefined) assert.equal(canonicalSubjectId(v.input, v.subjectCase, 'userId', invalid), v.canonical, label);
    else assert.throws(() => canonicalSubjectId(v.input, v.subjectCase, 'userId', invalid), (e) => e.code === v.error, label);
  }
});
