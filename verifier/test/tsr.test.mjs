// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The RFC 3161 token check on the real DigiCert token and a self-made TSA token.
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { issuerDer, makeToken, TEST_ROOT_PEM } from './make-token.mjs';
import { PINNED_ROOT_FINGERPRINTS, PINNED_TSA_ROOTS, isRealToken, tokenImprintHex, verifyTimestampToken } from '../lib/tsr.mjs';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));

test('the pinned root is DigiCert Trusted Root G4 with the recorded fingerprint', () => {
  assert.deepEqual(PINNED_TSA_ROOTS.map((r) => r.fingerprint256), PINNED_ROOT_FINGERPRINTS);
  assert.match(PINNED_TSA_ROOTS[0].subject, /CN=DigiCert Trusted Root G4/);
});
test('the real DigiCert token verifies, with the certificate times taken from its genTime', () => {
  const t = fixture('digicert-timestamp.tsr');
  assert.equal(isRealToken(t), true);
  assert.match(tokenImprintHex(t), /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifyTimestampToken(t));
});
test('a changed TSTInfo byte fails (messageDigest)', () => {
  const r = Buffer.from(fixture('digicert-timestamp.tsr'));
  const at = r.indexOf(Buffer.from('2026101604')); // genTime inside the TSTInfo
  assert.ok(at > 0);
  r[at + 9] = r[at + 9] === 0x34 ? 0x35 : 0x34;
  assert.throws(() => verifyTimestampToken(r), /messageDigest/);
});
test('a changed signature byte fails', () => {
  const r = Buffer.from(fixture('digicert-timestamp.tsr'));
  r[r.length - 10] ^= 1;
  assert.throws(() => verifyTimestampToken(r), /signed attributes do not verify/);
});
test('a self-made TSA fails against the pinned root and verifies only with its own root', () => {
  const self = fixture('selfmade-timestamp.tsr');
  assert.throws(() => verifyTimestampToken(self), /signer subject is not O=DigiCert/);
  assert.doesNotThrow(() => verifyTimestampToken(self, { roots: [new X509Certificate(fixture('selfmade-root.crt'))] }));
});
test('a time outside the certificate validity fails; garbage is not a real token', () => {
  assert.throws(() => verifyTimestampToken(fixture('digicert-timestamp.tsr'), { nowMs: Date.parse('2040-01-01T00:00:00Z') }), /pinned TSA root/);
  assert.throws(() => verifyTimestampToken(Buffer.from('30053003020100', 'hex')), /malformed/);
  assert.equal(isRealToken(Buffer.from('fake-tsr')), false);
});

// Signer rules, with a test TSA root (custom roots skip the DigiCert organisation rule unless signerOrg is set).
const roots = [new X509Certificate(TEST_ROOT_PEM)];
const IMPRINT = 'ab'.repeat(32);
const check = (token, extra = {}) => verifyTimestampToken(token, { roots, ...extra });

test('the test TSA token verifies; an extra unrelated certificate in the token does not matter', () => {
  assert.doesNotThrow(() => check(makeToken(IMPRINT)));
  assert.doesNotThrow(() => check(makeToken(IMPRINT, { extraCerts: [fixture('selfmade-root.crt').length ? new X509Certificate(fixture('selfmade-root.crt')).raw : Buffer.alloc(0)] })));
  assert.equal(tokenImprintHex(makeToken(IMPRINT)), IMPRINT);
});
test('a swapped signer (the sid names another issuer) fails', () => {
  const sid = { issuerDer: issuerDer(new X509Certificate(fixture('selfmade-root.crt'))) };
  assert.throws(() => check(makeToken(IMPRINT, { sid })), /signer certificate is not in the token/);
});
test('a signer with no EKU, a non-critical EKU or extra EKUs fails', () => {
  for (const signer of ['signer-noeku', 'signer-noncritical', 'signer-multi']) {
    assert.throws(() => check(makeToken(IMPRINT, { signer })), /critical extendedKeyUsage with only id-kp-timeStamping/, signer);
  }
});
test('an intermediate whose EKU lacks timeStamping fails; one without an EKU is fine', () => {
  assert.throws(() => check(makeToken(IMPRINT, { signer: 'signer-under-bad' })), /intermediate certificate has an EKU/);
  assert.doesNotThrow(() => check(makeToken(IMPRINT, { signer: 'signer-under-plain' })));
});
test('the signer organisation is checked when set, and is DigiCert, Inc. with the pinned root', () => {
  assert.doesNotThrow(() => check(makeToken(IMPRINT), { signerOrg: 'Test TSA' }));
  assert.throws(() => check(makeToken(IMPRINT), { signerOrg: 'DigiCert, Inc.' }), /signer subject is not O=DigiCert, Inc\./);
});
