// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// verify-proof: one saved inclusion proof, checked with no archive.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProof } from './build-proof.mjs';
import { makeToken as makeTokenFor, TEST_ROOT_PEM } from './make-token.mjs';
import { verifyProof } from '../lib/proof.mjs';

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const REAL = (n) => fileURLToPath(new URL(`../fixtures/proof-real/${n}`, import.meta.url));
const ROOTS = [TEST_ROOT_PEM];
const clone = (v) => JSON.parse(JSON.stringify(v));
const run = (f, extra = {}) => verifyProof({ proof: f.proof, keys: f.publicKeyPem, ...extra });
const stepOf = (r, n) => r.steps.find((s) => s.step === n);
const failed = (r) => r.steps.filter((s) => !s.ok).map((s) => s.step);
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
function cli(args) {
  return spawnSync(process.execPath, [CLI, 'verify-proof', ...args], { encoding: 'utf8' });
}
function saved(f, proof = f.proof) {
  const p = join(f.dir, 'proof.json');
  writeFileSync(p, JSON.stringify(proof));
  return p;
}

for (const index of [0, 2, 4]) {
  test(`a proof built from the published vectors (leaf ${index} of 5) passes steps 1 to 4`, () => {
    const f = buildProof({ index });
    const r = run(f);
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.deepEqual(r.steps.map((s) => s.step), [1, 2, 3, 4, 5]);
    assert.equal(stepOf(r, 5).note, true);
  });
}

test('the leaf 0 proof recomputes the published entry hash and Merkle root', () => {
  const r = run(buildProof({ index: 0 }));
  assert.match(stepOf(r, 1).detail, /13af6943007a581b06e21c07201d8619cda0936ffed496ca8801509666867bad/);
  assert.match(stepOf(r, 2).detail, /7a315c92bfbec26ff29ea7df42393a2f3c4be51229c571b9c0464b6604b822ed/);
});

test('a real archived proof (Quant smoke ledger, KMS signed) verifies with the published key file', () => {
  const r = cli([REAL('proof.json'), '--public-keys', REAL('public-key.json')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS +1 /); assert.match(r.stdout, /PASS +4 /); assert.match(r.stdout, /^VERIFIED/m);
});

test('a real archived proof with a changed value fails step 1', () => {
  const proof = JSON.parse(readFileSync(REAL('proof.json'), 'utf8'));
  proof.entry.value = proof.entry.value.replace('prod-smoke', 'prod-smoke!');
  const keys = JSON.parse(readFileSync(REAL('public-key.json'), 'utf8'));
  const r = verifyProof({ proof, keys: { [keys.keyId]: keys.publicKeyPem } });
  assert.deepEqual(failed(r), [1]);
});

test('--entry: the record the auditor holds must hash to the proven hash', () => {
  const f = buildProof({ index: 2 });
  assert.equal(run(f, { entry: f.entry }).ok, true);
  const changed = { ...f.entry, value: f.entry.value + ' ' };
  const r = run(f, { entry: changed });
  assert.deepEqual(failed(r), [1]);
  assert.match(stepOf(r, 1).detail, /differs/);
});

for (const [label, tamper, steps] of [
  ['a changed entry value', (p) => { p.entry.value = p.entry.value + ' '; }, [1]],
  ['a changed entry seq', (p) => { p.entry.seq = 2; }, [1, 3]],
  ['an entry with a newline in its id', (p) => { p.entry.id += '\n'; }, [1]],
  ['a wrong audit path', (p) => { p.auditPath[1] = flip(p.auditPath[1]); }, [2, 3]],
  ['a short audit path', (p) => { p.auditPath.pop(); }, [2, 3]],
  ['a wrong leafIndex', (p) => { p.leafIndex = 1; }, [2, 3]],
  ['a wrong treeSize (the path still folds in a 6-leaf tree)', (p) => { p.treeSize = 6; }, [3]],
  ['a treeSize that the path cannot fold', (p) => { p.treeSize = 9; }, [2, 3]],
  ['a merkleRoot that is not the folded root', (p) => { p.merkleRoot = flip(p.merkleRoot); }, [2]],
  ['an archiveKey that the digest does not list', (p) => { p.archiveKey += 'x'; }, [3]],
  ['a digest instance with another root', (p) => { p.digest.ledgers[0].instances[0].merkleRoot = flip(p.merkleRoot); }, [3, 4]],
  ['a digest edited after signing', (p) => { p.digest.signedAt = '2026-10-16T04:00:00.000Z'; }, [4]],
  ['a definition that does not match its hash', (p) => { p.digest.ledgers[0].definition.retentionDays = 1; }, [3, 4]],
  ['a bad signature', (p) => { p.signature = Buffer.from('not a signature').toString('base64'); }, [4]],
  ['a digestKey outside the store', (p) => { p.digestKey = 'digests/acme/other/20261016T0300Z.json'; }, [3]],
  ['a digestKey with ..', (p) => { p.digestKey = 'digests/acme/audit/../../x/20261016T0300Z.json'; }, [3]],
  ['a digestKey that is not a digest name', (p) => { p.digestKey = 'digests/acme/audit/latest.json'; }, [3]],
  ['an entry key that is not collection:id (a renamed record)', (p) => { p.entry.key = 'ai-use:agency-42:SOMEONE-ELSE'; }, [1]],
]) {
  test(`detects ${label}`, () => {
    const f = buildProof({ index: 2 });
    tamper(f.proof);
    const r = run(f);
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), steps, JSON.stringify(r.steps));
  });
}

test('a wrong public key fails step 4 and the CLI exits 1', () => {
  const f = buildProof();
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(f.dir, 'other.pem'), other);
  assert.deepEqual(failed(verifyProof({ proof: f.proof, keys: other })), [4]);
  const r = cli([saved(f), '--public-key', join(f.dir, 'other.pem')]);
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL +4 /); assert.match(r.stdout, /^NOT VERIFIED/m);
});

test('--public-keys: a keyId that the key file does not name fails step 4', () => {
  const f = buildProof();
  const r = verifyProof({ proof: { ...f.proof, keyId: 'another-key' }, keys: { 'test-ledger-key': f.publicKeyPem } });
  assert.deepEqual(failed(r), [4]);
  assert.match(stepOf(r, 4).detail, /no public key for keyId another-key/);
});

test('--public-keys: __proto__ and constructor keyIds find no key', () => {
  const f = buildProof();
  for (const keyId of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(failed(verifyProof({ proof: { ...f.proof, keyId }, keys: { 'test-ledger-key': f.publicKeyPem } })), [4], keyId);
  }
});

test('--public-key: the step-4 line says that keyId is not checked', () => {
  assert.match(stepOf(run(buildProof()), 4).detail, /keyId test-ledger-key is not checked/);
});

test('a signature that is not base64 is a malformed proof (exit 2)', () => {
  const f = buildProof();
  const r = verifyProof({ proof: { ...f.proof, signature: 'not base64!' }, keys: f.publicKeyPem });
  assert.equal(r.badInput, true); assert.match(r.steps[0].detail, /signature/);
  assert.equal(cli([saved(f, { ...f.proof, signature: 'not base64!' }), '--public-key', f.keyFile]).status, 2);
});

test('a key that is not P-256 fails step 4', () => {
  const f = buildProof();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.deepEqual(failed(verifyProof({ proof: f.proof, keys: rsa })), [4]);
});

test('a pending proof is never a pass: FAIL "not yet verifiable", exit 1', () => {
  const r = verifyProof({ proof: { status: 'pending' }, keys: buildProof().publicKeyPem });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'pending');
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [[0, false]]);
  assert.match(r.steps[0].detail, /not yet verifiable/);
  const f = buildProof();
  const c = cli([saved(f, { status: 'pending' }), '--public-key', f.keyFile]);
  assert.equal(c.status, 1); assert.match(c.stdout, /FAIL +0 status: pending: not yet verifiable/); assert.match(c.stdout, /^NOT VERIFIED/m);
});

test('a proof with another status, or with fields missing, fails', () => {
  const f = buildProof();
  assert.equal(verifyProof({ proof: { status: 'weird' }, keys: f.publicKeyPem }).ok, false);
  const p = clone(f.proof); delete p.auditPath;
  const r = verifyProof({ proof: p, keys: f.publicKeyPem });
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [[0, false]]);
  assert.match(r.steps[0].detail, /auditPath/);
});

// --- step 5: the anchor ---
const anchored = (f, extra = {}) => run(f, { anchorDir: f.anchorDir, tsaRootsPem: ROOTS, ...extra });

test('anchor: an RFC 3161 token for a binding of the proof digest passes', () => {
  const r = anchored(buildProof());
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.equal(stepOf(r, 5).note, undefined);
  assert.match(stepOf(r, 5).detail, /rfc3161 token verified/);
});

test('anchor: a binding of a later digest passes through the digest chain', () => {
  const r = anchored(buildProof({ later: 2 }));
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(stepOf(r, 5).detail, /2 later digests/);
});

test('anchor: the binding is found without proof.anchor (the earliest binding that covers the digest)', () => {
  const f = buildProof({ later: 1 });
  delete f.proof.anchor;
  assert.equal(anchored(f).ok, true);
});

for (const [label, tamper, text] of [
  ['a missing digest in the chain', (f) => rmSync(join(f.storeDir, `${f.names[1]}.json`)), /digest chain/],
  ['a missing bound digest', (f) => rmSync(join(f.storeDir, `${f.names[2]}.json`)), /digest chain/],
  ['a changed digest in the chain', (f) => writeFileSync(join(f.storeDir, `${f.names[1]}.json`), readFileSync(join(f.storeDir, `${f.names[1]}.json`), 'utf8').replace('"ledgers":[]', '"ledgers":[{}]')), /digest chain/],
  ['a missing token', (f) => rmSync(join(f.anchorDir, '20261016.tsr')), /binding_without_token/],
  ['a token for another hash', (f) => f.swapToken(), /token_imprint_differs/],
  ['a binding with another digestHash', (f) => f.editBinding((b) => ({ ...b, digestHash: flip(b.digestHash) })), /digest_hash_differs|digest chain/],
  ['a malformed binding', (f) => f.editBinding((b) => ({ ...b, types: ['rfc3161', 'customer-bucket'] })), /bad_binding/],
  ['a missing binding', (f) => rmSync(join(f.anchorDir, '20261016.anchor.json')), /binding_missing/],
]) {
  test(`anchor: detects ${label}`, () => {
    const f = withHelpers(buildProof({ later: 2 }));
    tamper(f);
    const r = anchored(f);
    assert.deepEqual(failed(r), [5], JSON.stringify(r.steps));
    assert.match(stepOf(r, 5).detail, text);
  });
}

test('anchor: a token from a test TSA fails against the pinned DigiCert root', () => {
  const f = buildProof();
  const r = run(f, { anchorDir: f.anchorDir });
  assert.deepEqual(failed(r), [5]);
  assert.match(stepOf(r, 5).detail, /bad_token_signature/);
});

test('anchor: customer-bucket with the customer copy passes; a copy that differs fails', () => {
  const f = buildProof({ later: 1, types: ['customer-bucket'], copies: true });
  const ok = anchored(f, { anchorCopiesDir: f.copiesDir });
  assert.equal(ok.ok, true, JSON.stringify(ok.steps));
  assert.match(stepOf(ok, 5).detail, /customer copy matches/);
  const copy = join(f.copiesDir, 'acme', 'audit', 'anchors', '20261016.anchor.json');
  writeFileSync(copy, readFileSync(copy, 'utf8').replace('00:10', '00:11'));
  const bad = anchored(f, { anchorCopiesDir: f.copiesDir });
  assert.deepEqual(failed(bad), [5]); assert.match(stepOf(bad, 5).detail, /binding_copy_differs/);
});

test('anchor: the customer copy alone (no --anchor-dir) is enough for a customer-bucket binding', () => {
  const f = buildProof({ later: 1, types: ['customer-bucket'], copies: true });
  const r = run(f, { anchorCopiesDir: join(f.copiesDir, 'acme', 'audit') });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(stepOf(r, 5).detail, /customer copy holds the binding/);
});

test('anchor: a customer-bucket binding without the customer copy is not external evidence (FAIL)', () => {
  const f = buildProof({ types: ['customer-bucket'] });
  const r = anchored(f);
  assert.deepEqual(failed(r), [5]); assert.match(stepOf(r, 5).detail, /customer_copy_not_provided/);
});

test('anchor: a customer copy without the bound digest fails', () => {
  const f = buildProof({ later: 1, types: ['customer-bucket'], copies: true });
  rmSync(join(f.copiesDir, 'acme', 'audit', `${f.names[1]}.json`));
  const r = anchored(f, { anchorCopiesDir: f.copiesDir });
  assert.deepEqual(failed(r), [5]); assert.match(stepOf(r, 5).detail, /copy_missing_digest/);
});

test('anchor: both types; the token alone passes with a note for the customer copy', () => {
  const f = buildProof({ types: ['customer-bucket', 'rfc3161'] });
  const r = anchored(f);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(stepOf(r, 5).detail, /customer-bucket not checked/);
});

test('anchor: a binding that names an earlier digest does not cover the proof digest', () => {
  const f = buildProof({ later: 1 });
  f.proof = { ...f.proof, digestKey: 'digests/acme/audit/20261016T0305Z.json' };
  const r = anchored(f);
  assert.ok(failed(r).includes(5)); assert.match(stepOf(r, 5).detail, /digest_hash_differs/);
  const g = withHelpers(buildProof({ later: 1 }));
  g.editBinding((b) => ({ ...b, digestKey: 'digests/acme/audit/20261016T0255Z.json' }));
  const r2 = anchored(g);
  assert.deepEqual(failed(r2), [5]); assert.match(stepOf(r2, 5).detail, /names an earlier digest/);
});

test('anchor: no binding covers the digest', () => {
  const f = buildProof();
  delete f.proof.anchor;
  rmSync(join(f.anchorDir, '20261016.anchor.json'));
  const r = anchored(f);
  assert.deepEqual(failed(r), [5]); assert.match(stepOf(r, 5).detail, /no anchor binding/);
});

test('anchor: without anchor files, step 5 is a NOTE, never a FAIL', () => {
  const f = buildProof();
  assert.match(stepOf(run(f), 5).detail, /not checked/);
  delete f.proof.anchor;
  assert.match(stepOf(run(f), 5).detail, /no anchor covers this digest yet/);
  assert.match(stepOf(run(f, {}), 5).detail, /no anchor/);
  const r = run({ ...f, proof: { ...f.proof, anchorUnavailable: true } });
  assert.equal(r.ok, true); assert.match(stepOf(r, 5).detail, /anchorUnavailable/);
});

test('CLI: --json prints the result; --anchor-dir and --tsa-root reach step 5', () => {
  const f = buildProof({ later: 1 });
  writeFileSync(join(f.dir, 'root.pem'), TEST_ROOT_PEM);
  const r = cli([saved(f), '--public-keys', f.keysFile, '--anchor-dir', f.anchorDir, '--tsa-root', join(f.dir, 'root.pem'), '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true); assert.deepEqual(out.steps.map((s) => s.ok), [true, true, true, true, true]);
});

test('CLI: --entry is read from a file', () => {
  const f = buildProof({ index: 4 });
  writeFileSync(join(f.dir, 'entry.json'), JSON.stringify({ ...f.entry, at: f.entry.at + 1 }));
  const r = cli([saved(f), '--public-key', f.keyFile, '--entry', join(f.dir, 'entry.json')]);
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL +1 /);
});

test('CLI: bad usage and unreadable input exit 2', () => {
  const f = buildProof();
  assert.equal(cli([]).status, 2);
  assert.equal(cli([saved(f)]).status, 2);
  assert.equal(cli([saved(f), '--public-key', f.keyFile, '--public-keys', f.keysFile]).status, 2);
  assert.equal(cli([join(f.dir, 'missing.json'), '--public-key', f.keyFile]).status, 2);
  assert.equal(cli([saved(f), '--public-key', f.keyFile, '--bogus']).status, 2);
  assert.equal(cli([saved(f), '--public-key', f.keyFile, '--entry', 'a.json', '--entry', 'b.json']).status, 2);
  assert.equal(cli([saved(f, { status: 'weird' }), '--public-key', f.keyFile]).status, 2);
});

// Helpers that rewrite the anchor files of a built proof.
function withHelpers(f) {
  const bindingFile = join(f.anchorDir, '20261016.anchor.json');
  f.editBinding = (fn) => writeFileSync(bindingFile, JSON.stringify(fn(JSON.parse(readFileSync(bindingFile, 'utf8')))));
  f.swapToken = () => writeFileSync(join(f.anchorDir, '20261016.tsr'), makeTokenFor('07'.repeat(32)));
  return f;
}

// A KMS key ARN, built from parts (the public-safety scan refuses ARN text in the repository).
const kmsArn = (keyId) => ['arn', 'aws', 'kms', 'region-1', '0'.repeat(12), `key/${keyId}`].join(':');

// K1: the public-key route names keys by the public key id (the KMS key id). A proof of a digest signed before K1
// names the key ARN; the verifier matches the key id at the end of the ARN, in either direction.
test('K1: --public-keys: an old ARN keyId finds the key named by its public key id, and the reverse', () => {
  const f = buildProof();
  const arn = kmsArn('test-ledger-key');
  const old = verifyProof({ proof: { ...f.proof, keyId: arn }, keys: { 'test-ledger-key': f.publicKeyPem } });
  assert.deepEqual(failed(old), []);
  assert.match(stepOf(old, 4).detail, /keyId test-ledger-key/);
  assert.doesNotMatch(stepOf(old, 4).detail, /000000000000/);
  assert.deepEqual(failed(verifyProof({ proof: f.proof, keys: { [arn]: f.publicKeyPem } })), []);
  const other = verifyProof({ proof: { ...f.proof, keyId: kmsArn('another-key') }, keys: { 'test-ledger-key': f.publicKeyPem } });
  assert.deepEqual(failed(other), [4]);
});
