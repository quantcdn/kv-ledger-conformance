// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// lib/proof-check.mjs: the four proof check steps of spec 7. A good proof passes; each tampered field fails its
// step; the failing steps match the offline verifier's steps 1 to 4 for the same proof.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkProof } from '../lib/proof-check.mjs';
import { verifyProof } from '../verifier/lib/proof.mjs';
import { buildProof } from '../verifier/test/build-proof.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const flip = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
const failed = (r) => r.steps.filter((s) => !s.ok).map((s) => s.step);
const verifierFailed = (proof, pem) => verifyProof({ proof, keys: pem }).steps
  .filter((s) => !s.ok && s.step <= 4).map((s) => s.step);

const fixture = buildProof({ index: 2 });
const otherPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });

test('a good proof passes the four steps', () => {
  const r = checkProof(fixture.proof, fixture.publicKeyPem);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map((s) => s.step), [1, 2, 3, 4]);
  for (const s of r.steps) assert.equal(typeof s.detail, 'string');
});

test('every leaf of the verifier fixture passes', () => {
  for (const index of [0, 1, 3, 4]) {
    const f = buildProof({ index });
    assert.equal(checkProof(f.proof, f.publicKeyPem).ok, true, `leaf ${index}`);
  }
});

test('the real platform proof fixture passes', () => {
  const read = (n) => JSON.parse(readFileSync(new URL(`../verifier/fixtures/proof-real/${n}`, import.meta.url), 'utf8'));
  const r = checkProof(read('proof.json'), read('public-key.json').publicKeyPem);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
});

// [label, tamper(proof), the step that must fail, public key override]
const TAMPERS = [
  ['entry value', (p) => { p.entry.value += ' '; }, 1],
  ['entry seq', (p) => { p.entry.seq += 1; }, 1],
  ['entry at', (p) => { p.entry.at += 1; }, 1],
  ['entry prevHash', (p) => { p.entry.prevHash = flip(p.entry.prevHash); }, 1],
  ['hash', (p) => { p.hash = flip(p.hash); }, 1],
  ['auditPath element', (p) => { p.auditPath[0] = flip(p.auditPath[0]); }, 2],
  ['auditPath length', (p) => { p.auditPath.pop(); }, 2],
  ['leafIndex', (p) => { p.leafIndex += 1; }, 2],
  // Leaf 2 of 6 folds like leaf 2 of 5, so step 3 (the size of the digest instance) catches it.
  ['treeSize', (p) => { p.treeSize += 1; }, 3],
  ['merkleRoot', (p) => { p.merkleRoot = flip(p.merkleRoot); }, 2],
  ['digest instance merkleRoot', (p) => {
    p.digest.ledgers[0].instances[0].merkleRoot = flip(p.digest.ledgers[0].instances[0].merkleRoot);
  }, 3],
  ['digest instance fromSeq', (p) => { p.digest.ledgers[0].instances[0].fromSeq += 1; }, 3],
  ['digest instance shard', (p) => { p.digest.ledgers[0].instances[0].shard = '09'; }, 3],
  ['archiveKey', (p) => { p.archiveKey += 'x'; }, 3],
  ['digestKey', (p) => { p.digestKey = 'digests/other/x/20261016T0300Z.json'; }, 3],
  ['definition', (p) => { p.digest.ledgers[0].definition.chains += 1; }, 3],
  ['digest signedAt', (p) => { p.digest.signedAt = '2026-10-16T03:06:13.000Z'; }, 4],
  ['signature', (p) => { p.signature = Buffer.from(Buffer.from(p.signature, 'base64').map((b, i) => (i === 10 ? b ^ 1 : b))).toString('base64'); }, 4],
  ['wrong key', () => {}, 4, otherPem],
];

for (const [label, tamper, step, pem] of TAMPERS) {
  test(`tampered ${label} fails step ${step}, like the verifier`, () => {
    const proof = clone(fixture.proof);
    tamper(proof);
    const key = pem ?? fixture.publicKeyPem;
    const r = checkProof(proof, key);
    assert.equal(r.ok, false);
    assert.ok(failed(r).includes(step), `step ${step} fails: ${JSON.stringify(r.steps)}`);
    assert.deepEqual(failed(r), verifierFailed(proof, key), 'same failing steps as the verifier');
  });
}

test('a pending or malformed proof fails at step 0', () => {
  for (const proof of [{ status: 'pending' }, null, { status: 'archived' }, { ...clone(fixture.proof), signature: '' }]) {
    const r = checkProof(proof, fixture.publicKeyPem);
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), [0]);
  }
});

test('a key that is not P-256 fails step 4', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.deepEqual(failed(checkProof(fixture.proof, rsa)), [4]);
  assert.deepEqual(failed(checkProof(fixture.proof, 'not a pem')), [4]);
});
