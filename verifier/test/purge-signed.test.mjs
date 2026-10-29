// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RECEIPT_MEANING, verifySigned } from '../lib/signed.mjs';
import { canonicalJson } from '../lib/jcs.mjs';
import { sha256Hex } from '../lib/hash.mjs';
import { buildPurge } from './build-purge.mjs';

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));

test('a purge receipt signed by the key verifies with verdict PURGED', async () => {
  const p = await buildPurge();
  const r = verifySigned(p.receiptDoc, p.publicKeyPem);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.verdict, 'PURGED');
});

const FAULTS = {
  'v 2': (r) => { r.v = 2; },
  'an unknown top-level field': (r) => { r.extra = 1; },
  'purgeId x': (r) => { r.purgeId = 'x'; },
  'scope ledger': (r) => { r.scope = 'ledger'; },
  'requestedBy admin': (r) => { r.requestedBy = 'admin'; },
  'requestedBy agent:foo': (r) => { r.requestedBy = 'agent:foo'; },
  'requestedBy user:abc': (r) => { r.requestedBy = 'user:abc'; },
  'a ledger record without definitionHash': (r) => { delete r.storeRecord.ledgers[0].definitionHash; },
  'a ledger record with a bad lockMode': (r) => { r.storeRecord.ledgers[0].lockMode = 'legal-hold'; },
  'a ledger record with a fractional retentionDays': (r) => { r.storeRecord.ledgers[0].retentionDays = 1.5; },
  'chain.firstDigest missing': (r) => { delete r.chain.firstDigest; },
  'completedAt date only': (r) => { r.completedAt = '2026-10-24'; },
  'emptiness.versions 1': (r) => { r.emptiness.versions = 1; },
  'emptiness.deleteMarkers 1': (r) => { r.emptiness.deleteMarkers = 1; },
  'manifestSha256 wrong': (r) => { r.objects.manifestSha256 = sha256Hex('x'); },
  'a manifest entry without count': (r) => { delete r.objects.manifest[0].count; r.objects.manifestSha256 = sha256Hex(canonicalJson(r.objects.manifest)); },
  'lastDigestHash not hex': (r) => { r.chain.lastDigestHash = 'zz'; },
  'a residual kind outside the known kinds': (r) => { r.residual.push({ kind: 'other', until: '2026-11-01T00:00:00Z' }); },
};
test('purge receipt shape: each fault is refused', async () => {
  for (const [name, fn] of Object.entries(FAULTS)) {
    const p = await buildPurge();
    p.edit(fn); p.resign();
    const r = verifySigned(p.receiptDoc, p.publicKeyPem);
    assert.equal(r.ok, false, name);
    assert.match(r.reason, /^malformed purge receipt: /, name);
  }
});

test('times with and without milliseconds are accepted (R6)', async () => {
  for (const t of ['2026-10-24T00:00:00Z', '2026-10-24T00:00:00.123Z']) {
    const p = await buildPurge();
    p.edit((r) => { r.completedAt = t; }); p.resign();
    assert.equal(verifySigned(p.receiptDoc, p.publicKeyPem).ok, true, t);
  }
});

test('verify-signed CLI: PURGED exit 0 with a summary line; a changed byte exit 4', async () => {
  const p = await buildPurge();
  const run = () => spawnSync(process.execPath, [CLI, 'verify-signed', '--doc', p.receiptFile, '--public-keys', p.keysFile], { encoding: 'utf8' });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  const r = p.receipt;
  assert.equal(ok.stdout.split('\n')[1], `PURGED kv-ledger-archive-purge-receipt ${r.purgeId} acme/audit: ${r.objects.count} objects, ${r.objects.bytes} bytes, completedAt ${r.completedAt}, last digest ${r.chain.lastDigest}`);
  assert.ok(ok.stdout.includes(RECEIPT_MEANING.PURGED));
  const doc = JSON.parse(readFileSync(p.receiptFile, 'utf8'));
  doc.json = doc.json.replace('"scope":"store"', '"scope":"stora"');
  writeFileSync(p.receiptFile, JSON.stringify(doc));
  const bad = run();
  assert.equal(bad.status, 4);
  assert.match(bad.stdout, /signature invalid/);
});
