// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../lib/jcs.mjs';
import { keysFromJson, verifySigned } from '../lib/signed.mjs';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, pem: publicKey.export({ format: 'pem', type: 'spki' }).toString() };
};
const k1 = pair(), k2 = pair();
const report = { v: 1, type: 'kv-ledger-verification-report', org: 'acme', store: 'audit', ledger: 'aiUse', id: '01M5104A000000000000000000',
  at: '2026-10-16T16:20:00.000Z', startedAt: '2026-10-16T16:17:00.000Z', trigger: 'api', scope: {}, complete: true, ok: true, entries: 9, shardsFailed: 0, failures: [] };
// The server's scheme: base64 DER ECDSA over the SHA-256 of the JCS bytes.
function signedDoc(value, key = k1.privateKey, keyId = 'arn:k1') {
  const json = canonicalJson(value);
  return { report: value, json, keyId, algorithm: 'ECDSA_SHA_256', signature: sign('sha256', Buffer.from(json, 'utf8'), { key, dsaEncoding: 'der' }).toString('base64') };
}

test('a document signed by the key passes; one changed byte of json fails; a wrong key fails', () => {
  const doc = signedDoc(report);
  const r = verifySigned({ json: doc.json, signature: doc.signature, keyId: doc.keyId }, k1.pem);
  assert.equal(r.ok, true);
  assert.deepEqual(r.signed, report);
  const flipped = doc.json.replace('"ok":true', '"ok":fals') + '';
  assert.equal(verifySigned({ ...doc, report: undefined, json: flipped }, k1.pem).ok, false);
  const oneByte = doc.json.replace('"entries":9', '"entries":8');
  assert.deepEqual(verifySigned({ ...doc, report: undefined, json: oneByte }, k1.pem), { ok: false, reason: 'bad signature' });
  assert.deepEqual(verifySigned(doc, k2.pem), { ok: false, reason: 'bad signature' });
});
test('the unsigned report must equal the signed json; json must be canonical', () => {
  const doc = signedDoc(report);
  assert.deepEqual(verifySigned({ ...doc, report: { ...report, ok: false } }, k1.pem), { ok: false, reason: 'report differs from the signed json' });
  const spaced = JSON.stringify(report, null, 1);
  const loose = { json: spaced, keyId: 'arn:k1', signature: sign('sha256', Buffer.from(spaced), { key: k1.privateKey, dsaEncoding: 'der' }).toString('base64') };
  assert.deepEqual(verifySigned(loose, k1.pem), { ok: false, reason: 'json is not in canonical (JCS) form' });
});
test('keys by keyId: the key the document names is used; an unknown keyId fails; a non-P-256 key fails; bad shapes fail', () => {
  const keys = keysFromJson(JSON.stringify([{ keyId: 'arn:k1', publicKeyPem: k1.pem }, { keyId: 'arn:k2', publicKeyPem: k2.pem }]));
  assert.equal(verifySigned(signedDoc(report, k2.privateKey, 'arn:k2'), keys).ok, true);
  assert.deepEqual(verifySigned(signedDoc(report, k1.privateKey, 'arn:k2'), keys), { ok: false, reason: 'bad signature' });
  assert.equal(verifySigned(signedDoc(report, k1.privateKey, 'arn:other'), keys).reason, 'no public key for keyId arn:other');
  assert.equal(verifySigned(signedDoc(report), keysFromJson(JSON.stringify({ keyId: 'arn:k1', publicKeyPem: k1.pem }))).ok, true, 'the public-key route answer');
  assert.equal(verifySigned(signedDoc(report), keysFromJson(JSON.stringify({ 'arn:k1': k1.pem }))).ok, true, 'a keyId map');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
  assert.equal(verifySigned(signedDoc(report), rsa).reason, 'the public key is not an ECDSA P-256 key');
  for (const bad of [null, [], {}, { json: 'x' }, { json: '{}', signature: 'not base64!' }, { ...signedDoc(report), algorithm: 'RSA' }]) {
    assert.equal(verifySigned(bad, k1.pem).ok, false, JSON.stringify(bad));
  }
  assert.throws(() => keysFromJson('[1]'));
});

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));
test('verify-signed CLI: signature valid then INTACT exit 0, FAILED exit 1, INCOMPLETE exit 3; a bad signature exit 4; bad input exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-signed-'));
  try {
    const doc = signedDoc(report);
    writeFileSync(join(dir, 'report.json'), JSON.stringify(doc));
    writeFileSync(join(dir, 'key.pem'), k1.pem);
    writeFileSync(join(dir, 'other.pem'), k2.pem);
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ keyId: 'arn:k1', publicKeyPem: k1.pem }));
    const run = (...args) => spawnSync(process.execPath, [CLI, 'verify-signed', ...args], { encoding: 'utf8' });
    const pass = run('--doc', join(dir, 'report.json'), '--public-key', join(dir, 'key.pem'));
    assert.equal(pass.status, 0, pass.stderr);
    const lines = pass.stdout.split('\n');
    assert.match(lines[0], /^signature valid/);
    assert.match(lines[1], /^INTACT kv-ledger-verification-report /);
    assert.deepEqual(JSON.parse(lines.slice(2).join('\n')), report);
    for (const [value, status, verdict] of [[{ ...report, ok: false, shardsFailed: 1 }, 1, 'FAILED'], [{ ...report, complete: false, ok: false }, 3, 'INCOMPLETE']]) {
      writeFileSync(join(dir, 'other.json'), JSON.stringify(signedDoc(value)));
      const r = run('--doc', join(dir, 'other.json'), '--public-key', join(dir, 'key.pem'));
      assert.deepEqual([r.status, r.stdout.split('\n')[1].split(' ')[0]], [status, verdict]);
    }
    assert.equal(run('--doc', join(dir, 'report.json'), '--public-keys', join(dir, 'keys.json')).status, 0);
    const failed = run('--doc', join(dir, 'report.json'), '--public-key', join(dir, 'other.pem'));
    assert.deepEqual([failed.status, failed.stdout.trim()], [4, 'signature invalid: bad signature']);
    assert.equal(run('--doc', join(dir, 'report.json')).status, 2);
    assert.equal(run('--doc', join(dir, 'missing.json'), '--public-key', join(dir, 'key.pem')).status, 2);
    assert.equal(run('--doc', join(dir, 'report.json'), '--public-key', join(dir, 'key.pem'), '--public-keys', join(dir, 'keys.json')).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the verdict comes from the signed json; an unknown document type is refused', () => {
  const verdict = (v) => verifySigned(signedDoc(v), k1.pem).verdict;
  assert.equal(verdict(report), 'INTACT');
  assert.equal(verdict({ ...report, ok: false, shardsFailed: 2 }), 'FAILED');
  assert.equal(verdict({ ...report, complete: true, ok: false, shardsFailed: 0 }), 'FAILED');
  assert.equal(verdict({ ...report, complete: false, ok: false, shardsFailed: 0 }), 'INCOMPLETE');
  assert.equal(verdict({ ...report, complete: false, ok: false, shardsFailed: 1 }), 'FAILED', 'a failure found on the way is a failure');
  assert.equal(verdict({ ...report, complete: false, ok: true }), 'INCOMPLETE', 'never intact without complete');
  assert.deepEqual(verifySigned(signedDoc({ ...report, type: 'something-else' }), k1.pem), { ok: false, reason: 'unknown document type something-else' });
  assert.equal(verifySigned(signedDoc({ hello: 1 }), k1.pem).ok, false);
});

// Task 46: shred receipts.
import { entriesSha256 } from '../lib/signed.mjs';
const entries = [{ key: 'ai-use:a:01M5104A000000000000000000-00', shard: '00', seq: 7, hash: 'ab'.repeat(32) }];
const receipt = { v: 1, type: 'kv-ledger-shred-receipt', id: '01M5104A00ER2CRR3DHK1FVYH0', org: 'acme', store: 'audit', ledger: 'aiUse',
  subjectRef: '7604cc606d8cc2fdfa20af770a374f89', shreddedAt: '2026-10-16T03:00:00.000Z', fullyErasedAfter: '2026-11-20T03:00:00.000Z',
  reason: 'Erasure request', authority: 'APP 13', requestedBy: 'Privacy officer', entryCount: 1, entriesSha256: entriesSha256(entries), entries };
// A v2 receipt: refKeyVersion is required; backfilled and keyReissued no longer exist.
const receiptV2 = (extra = {}) => ({ ...receipt, v: 2, refKeyVersion: 1, ...extra });
const forkedReceipt = { ...receipt, entries: [], entryCount: 0, entriesSha256: entriesSha256([]), ledgerForked: true };
const signedReceipt = (value, key = k1.privateKey) => {
  const { report: _r, ...rest } = signedDoc(value, key);
  return { receipt: value, ...rest };
};
test('a shred receipt: RECORDED, FORKED-NOT-RECORDED, NOT-RECORDED; the receipt field must equal json', () => {
  const verdict = (v) => verifySigned(signedReceipt(v), k1.pem).verdict;
  assert.equal(verdict(receipt), 'RECORDED');
  assert.equal(verdict(forkedReceipt), 'FORKED-NOT-RECORDED');
  assert.equal(verdict({ ...forkedReceipt, ledgerForked: undefined }), 'NOT-RECORDED');
  const { entries: _e, ...large } = receipt;
  assert.equal(verdict(large), 'RECORDED', 'a receipt above 300 KB lists no entries; entryCount and entriesSha256 bind them');
  const doc = signedReceipt(receipt);
  assert.deepEqual(verifySigned({ ...doc, receipt: { ...receipt, subjectRef: '0'.repeat(32) } }, k1.pem), { ok: false, reason: 'receipt differs from the signed json' });
  const { receipt: _p, ...bare } = doc;
  assert.equal(verifySigned(bare, k1.pem).verdict, 'RECORDED', 'the receipt object of a shred answer (no parsed copy) verifies');
  assert.deepEqual(verifySigned({ ...bare, json: bare.json.replace('"seq":7', '"seq":8') }, k1.pem), { ok: false, reason: 'bad signature' });
});
test('a well-signed but malformed receipt is refused (signature invalid: malformed receipt)', () => {
  const bad = [
    [{ ...receipt, v: 3 }, 'v is not 1 or 2'], [{ ...receipt, extra: 1 }, 'an unknown receipt field'], [{ ...receipt, id: 'x' }, 'id or supersedes is not a shred id'],
    [{ ...receipt, reason: '' }, 'a missing org'], [{ ...receipt, subjectRef: 'u-17' }, 'subjectRef is not 32 hex'], [{ ...receipt, shreddedAt: 'today' }, 'not an ISO time'],
    [{ ...receipt, entryCount: -1 }, 'entryCount or entriesSha256'], [{ ...receipt, ledgerForked: true }, 'ledgerForked with shred entries'],
    [{ ...receipt, entries: [{ ...entries[0], shard: 'x' }] }, 'a malformed shred entry'], [{ ...receipt, entryCount: 2 }, 'entries do not match'],
    [{ ...receipt, entriesSha256: 'cd'.repeat(32) }, 'entries do not match'],
  ];
  for (const [value, why] of bad) {
    const r = verifySigned(signedReceipt(value), k1.pem);
    assert.equal(r.ok, false, why); assert.match(r.reason, /^malformed receipt: /); assert.ok(r.reason.includes(why), `${r.reason} / ${why}`);
  }
});
test('verify-signed CLI on a receipt: RECORDED exit 0 with what it proves, FORKED-NOT-RECORDED exit 3, malformed or tampered exit 4, --entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-receipt-'));
  try {
    writeFileSync(join(dir, 'key.pem'), k1.pem);
    const run = (value, mutate = (d) => d, extra = []) => {
      writeFileSync(join(dir, 'receipt.json'), JSON.stringify(mutate(signedReceipt(value))));
      return spawnSync(process.execPath, [CLI, 'verify-signed', '--doc', join(dir, 'receipt.json'), '--public-key', join(dir, 'key.pem'), ...extra], { encoding: 'utf8' });
    };
    const ok = run(receipt);
    assert.equal(ok.status, 0, ok.stderr);
    const lines = ok.stdout.split('\n');
    assert.match(lines[1], /^RECORDED kv-ledger-shred-receipt 01M5104A00ER2CRR3DHK1FVYH0 acme\/audit ledger aiUse: subjectRef 7604cc606d8cc2fdfa20af770a374f89, shreddedAt .*, 1 shred entries$/);
    assert.equal(lines[2], "Quant signed that this erasure's shred entries are on the ledger record; prove each entry with the proof route or verify.");
    assert.deepEqual(JSON.parse(lines.slice(3).join('\n')), receipt);
    const forked = run(forkedReceipt);
    assert.deepEqual([forked.status, forked.stdout.split('\n')[1].split(' ')[0]], [3, 'FORKED-NOT-RECORDED']);
    assert.match(forked.stdout.split('\n')[1], /ledger forked$/);
    assert.equal(run(receipt, (d) => ({ ...d, json: d.json.replace('"seq":7', '"seq":9'), receipt: undefined })).status, 4);
    assert.equal(run({ ...receipt, entryCount: 5 }).status, 4, 'a malformed signed receipt');
    const { entries: _e, ...large } = receipt;
    writeFileSync(join(dir, 'entries.json'), JSON.stringify([{ shredId: receipt.id, entryCount: 1, entries }]));
    const withEntries = run(large, (d) => d, ['--entries', join(dir, 'entries.json')]);
    assert.equal(withEntries.status, 0, withEntries.stdout); assert.match(withEntries.stdout, /The given entries match the receipt\./);
    writeFileSync(join(dir, 'entries.json'), JSON.stringify([{ ...entries[0], seq: 8 }]));
    const wrong = run(large, (d) => d, ['--entries', join(dir, 'entries.json')]);
    assert.deepEqual([wrong.status, wrong.stdout.trim()], [4, 'signature invalid: the entries do not match entryCount and entriesSha256']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a backfilled receipt: backfilled and keyReissued are known fields; keyReissued needs backfilled; the CLI line says so', () => {
  const back = { ...receipt, backfilled: true, keyReissued: true };
  assert.equal(verifySigned(signedReceipt(back), k1.pem).verdict, 'RECORDED');
  assert.match(verifySigned(signedReceipt({ ...receipt, keyReissued: true }), k1.pem).reason, /backfilled or keyReissued is malformed/);
  assert.match(verifySigned(signedReceipt({ ...receipt, backfilled: false }), k1.pem).reason, /backfilled or keyReissued is malformed/);
  const dir = mkdtempSync(join(tmpdir(), 'kv-backfilled-'));
  try {
    writeFileSync(join(dir, 'key.pem'), k1.pem); writeFileSync(join(dir, 'r.json'), JSON.stringify(signedReceipt(back)));
    const r = spawnSync(process.execPath, [CLI, 'verify-signed', '--doc', join(dir, 'r.json'), '--public-key', join(dir, 'key.pem')], { encoding: 'utf8' });
    assert.equal(r.status, 0); assert.match(r.stdout.split('\n')[1], /backfilled: key re-issued, shreddedAt is the earliest shred entry$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accepts a v2 receipt with refKeyVersion', () => {
  assert.equal(verifySigned(signedReceipt(receiptV2()), k1.pem).verdict, 'RECORDED');
});
test('still accepts a v1 receipt', () => {
  assert.equal(verifySigned(signedReceipt(receipt), k1.pem).verdict, 'RECORDED');
});
test('rejects v2 with backfilled or keyReissued', () => {
  for (const extra of [{ backfilled: true }, { keyReissued: true }, { backfilled: true, keyReissued: true }]) {
    const r = verifySigned(signedReceipt(receiptV2(extra)), k1.pem);
    assert.equal(r.ok, false); assert.match(r.reason, /^malformed receipt: /);
  }
});
test('rejects v2 without refKeyVersion and a refKeyVersion that is not a positive integer', () => {
  const { refKeyVersion: _r, ...without } = receiptV2();
  for (const v of [without, receiptV2({ refKeyVersion: 0 }), receiptV2({ refKeyVersion: -1 }), receiptV2({ refKeyVersion: 1.5 }), receiptV2({ refKeyVersion: '1' })]) {
    const r = verifySigned(signedReceipt(v), k1.pem);
    assert.equal(r.ok, false); assert.match(r.reason, /refKeyVersion/);
  }
});
test('rejects refKeyVersion on a v1 receipt, and v3', () => {
  assert.match(verifySigned(signedReceipt({ ...receipt, refKeyVersion: 1 }), k1.pem).reason, /refKeyVersion/);
  assert.match(verifySigned(signedReceipt({ ...receipt, v: 3, refKeyVersion: 1 }), k1.pem).reason, /v is not 1 or 2/);
});
