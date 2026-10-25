// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Packaging: the package exports resolve by the package name (self-reference), and `npm pack` ships what a consumer
// needs (every relative import of a shipped module is shipped too) and nothing test-only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAME = '@quantcdn/kv-ledger-conformance';
const require = createRequire(import.meta.url);

test('the main export has run, cases, the version and the limits', async () => {
  const mod = await import(NAME);
  assert.equal(typeof mod.run, 'function');
  assert.ok(Array.isArray(mod.cases) && mod.cases.length > 0);
  assert.equal(typeof mod.SUITE_VERSION, 'string');
  assert.equal(typeof mod.LIMITS, 'object');
});

test('the verifier export is a library with the main checks and no side effects', async () => {
  const mod = await import(`${NAME}/verifier`);
  for (const name of ['verifyArchive', 'verifyProof', 'verifySigned', 'purgeCheck', 'keysFromJson', 'verifyTimestampToken']) {
    assert.equal(typeof mod[name], 'function', name);
  }
  assert.equal(process.exitCode, undefined, 'importing the library does not run the CLI');
});

test('the vectors export is the golden vector file', () => {
  const vectors = require(`${NAME}/vectors/ledger-vectors.json`);
  const local = JSON.parse(readFileSync(join(ROOT, 'vectors/ledger-vectors.json'), 'utf8'));
  assert.deepEqual(vectors, local);
});

test('each adapter export has createAdapter', async () => {
  for (const name of ['reference', 'http', 'edge-harness']) {
    const mod = await import(`${NAME}/adapters/${name}`);
    assert.equal(typeof mod.createAdapter, 'function', name);
  }
});

test('an emulator gets the local backend and the edge layer parts from the exports', async () => {
  const reference = await import(`${NAME}/adapters/reference`);
  assert.equal(typeof reference.createLocalBackend, 'function');
  const main = await import(NAME);
  for (const name of ['createEdgeCalls', 'createEdgeChecks', 'createKVErrorClass', 'buildKvStore']) {
    assert.equal(typeof main[name], 'function', name);
  }
  const KVError = main.createKVErrorClass();
  const backend = reference.createLocalBackend({ clock: main.createVirtualClock(), KVError });
  const calls = main.createEdgeCalls({ backend, checks: main.createEdgeChecks(KVError), KVError, isAllowed: () => true });
  const kvStore = main.buildKvStore(calls, KVError);
  assert.equal(typeof kvStore.get, 'function');
});

function packedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

// The relative module and file references of a source text.
const REFS = [/(?:import|export)[^'"]*?from\s+'(\.{1,2}\/[^']+)'/g, /import\('(\.{1,2}\/[^']+)'\)/g, /new URL\('(\.{1,2}\/[^']+)'/g];
const refsOf = (text) => REFS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]));

test('npm pack ships every runtime file and nothing test-only', (t) => {
  let files;
  try {
    files = packedFiles();
  } catch {
    t.skip('npm is not available');
    return;
  }
  const shipped = new Set(files);
  const needed = ['README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'package.json', 'index.mjs', 'run.mjs',
    'lib/runner.mjs', 'cases/index.mjs', 'vectors/ledger-vectors.json', 'fixtures/subject-v1-vectors.json',
    'adapters/reference/index.mjs', 'adapters/http/index.mjs', 'adapters/edge-harness/harness-fn.js',
    'verifier/index.mjs', 'verifier/verify.mjs', 'verifier/lib/verify.mjs', 'verifier/README.md'];
  for (const file of needed) assert.ok(shipped.has(file), `ships ${file}`);
  const testOnly = files.filter((f) => /^(test|docs|\.github|verifier\/test|verifier\/fixtures)\//.test(f) || f.endsWith('.key'));
  assert.deepEqual(testOnly, []);
  const missing = files.filter((f) => /\.m?js$/.test(f)).flatMap((file) =>
    refsOf(readFileSync(join(ROOT, file), 'utf8')).map((ref) => normalize(join(dirname(file), ref)))
      .filter((ref) => !shipped.has(ref)).map((ref) => `${file} -> ${ref}`));
  assert.deepEqual(missing, []);
});
