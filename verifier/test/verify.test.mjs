// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, renameSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildFixture } from './build-fixture.mjs';
import { TEST_ROOT_PEM } from './make-token.mjs';
const TEST_ROOTS = [TEST_ROOT_PEM];
import { verifyArchive } from '../lib/verify.mjs';

test('an untouched archive verifies, receipts and anchors match', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, receipts: f.receipts, anchorsDir: f.anchorsDir });
  assert.equal(r.ok, true); assert.equal(r.entries, 7);
  assert.deepEqual(r.receipts, { checked: 7, mismatched: [] }); assert.deepEqual(r.anchors, { checked: 2, mismatched: [] });
});
for (const [label, tamper, reason, seq] of [
  ['changed line', f => f.rewriteLine(3, l => ({ ...l, value: '{"type":"plaintext","value":{"n":99}}' })), 'hash_mismatch', 3],
  ['dropped line', f => f.dropLine(5), 'missing_entry', 5],
  ['recomputed chain', f => f.rechainFrom(4), 'digest_mismatch', 4],
  ['forged digest', f => f.editDigest(0, d => ({ ...d, signedAt: 'x' })), 'bad_signature', 1],
  ['broken digest chain', f => f.editDigestUnsigned(1, d => ({ ...d, prevDigestHash: '0'.repeat(64) })), 'bad_signature', 5],
]) {
  test(`detects: ${label}`, async () => {
    const f = await buildFixture({ entries: 7, periods: 2 });
    await tamper(f);
    const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
    assert.equal(r.ok, false);
    const bad = r.shards.find(s => !s.ok);
    assert.deepEqual([bad.reason, bad.firstBrokenSeq], [reason, seq]);
  });
}
test('a receipt that disagrees with the archive is reported', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  f.receipts[1] = { ...f.receipts[1], hash: 'f'.repeat(64) };
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, receipts: f.receipts });
  assert.equal(r.ok, false); assert.deepEqual(r.receipts.mismatched, [f.receipts[1].key]);
});
test('a timestamp token for another digest is reported', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.corruptAnchor(0);
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });
  assert.equal(r.ok, false); assert.equal(r.anchors.mismatched.length, 1);
});
test('a wrong public key fails every shard', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  const other = await buildFixture({ entries: 1, periods: 1 });
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: other.publicKeyPem });
  assert.deepEqual([r.ok, r.shards[0].reason], [false, 'bad_signature']);
});
import { generateKeyPairSync } from 'node:crypto';

const firstBad = (r) => r.shards.find(s => !s.ok);

test('a very large shard verifies (no argument-spread overflow)', async () => {
  const f = await buildFixture({ entries: 250000, periods: 1 });
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.equal(r.ok, true); assert.equal(r.entries, 250000);
  assert.deepEqual([r.shards[0].fromSeq, r.shards[0].toSeq], [1, 250000]);
});
test('tail truncation is caught when the token is kept', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.truncateLastPeriod();
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });
  assert.equal(r.ok, false); assert.equal(r.anchors.mismatched.length, 1);
});
test('a removed token is reported as an unanchored day', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.removeAnchor(1);
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.unanchoredDays, ['acme/audit/20261015']);
});
test('a corrupt object and a bad line are verification failures', async () => {
  let f = await buildFixture({ entries: 7, periods: 2 });
  f.corruptObject(1);
  let r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.deepEqual([firstBad(r).reason, firstBad(r).firstBrokenSeq], ['missing_entry', 5]);
  f = await buildFixture({ entries: 7, periods: 2 });
  f.garbleLine(0);
  r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.equal(firstBad(r).reason, 'hash_mismatch');
});
test('digest_mismatch reports the whole object range', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.rechainFrom(4);
  const b = firstBad(await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem }));
  assert.deepEqual([b.objectFromSeq, b.objectToSeq], [1, 4]);
});
test('a non-P-256 key fails every signature', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(firstBad(await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: rsa })).reason, 'bad_signature');
});
test('a missing .sig is a bad signature', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  f.removeSig(0);
  assert.equal(firstBad(await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem })).reason, 'bad_signature');
});
test('digest deleted: digest_mismatch at 1 with the object range, as the server reports', async () => {
  const f = await buildFixture({ entries: 5, periods: 1 });
  f.removeDigest(0);
  const b = firstBad(await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem }));
  assert.deepEqual([b.reason, b.firstBrokenSeq, b.objectFromSeq, b.objectToSeq], ['digest_mismatch', 1, 1, 5]);
});
// The fixture period 20261014T2355Z ends at 2026-10-15T00:00Z; the digest grace ends one hour later.
const graceRun = async (opts) => {
  const f = await buildFixture({ entries: 5, periods: 1 });
  f.removeDigest(0);
  return verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, ...opts });
};
test('no digest yet, inside the grace: pending, not a failure', async () => {
  const r = await graceRun({ asOf: Date.parse('2026-10-15T00:20:00Z') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pending.map(({ collection, shard, fromSeq, toSeq }) => ({ collection, shard, fromSeq, toSeq })), [{ collection: r.shards[0].collection, shard: r.shards[0].shard, fromSeq: 1, toSeq: 5 }]);
});
test('no digest, after the grace: digest_mismatch', async () => {
  const r = await graceRun({ asOf: Date.parse('2026-10-15T01:01:00Z') });
  assert.equal(r.ok, false); assert.equal(firstBad(r).reason, 'digest_mismatch'); assert.deepEqual(r.pending, []);
});
test('no digest, inside the grace, strict: a failure', async () => {
  const r = await graceRun({ asOf: Date.parse('2026-10-15T00:20:00Z'), strict: true });
  assert.equal(r.ok, false); assert.equal(r.pending.length, 1);
});
test('exactly periodEnd + 1 h: no longer pending', async () => {
  const r = await graceRun({ asOf: Date.parse('2026-10-15T01:00:00Z') });
  assert.equal(r.ok, false); assert.deepEqual(r.pending, []);
  assert.equal((await graceRun({ asOf: Date.parse('2026-10-15T00:59:59Z') })).ok, true);
});
test('a period label in the future is archive_mismatch, never pending', async () => {
  const f = await buildFixture({ entries: 5, periods: 1 });
  f.removeDigest(0);
  const dir = join(f.dir, 'ledgers/acme/audit');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(dir).filter((x) => x.endsWith('.jsonl.gz'))) {
    renameSync(file, file.replace(/\/[^/]*?(-\d{12}-\d{12}\.jsonl\.gz)$/, '/20991231T2355Z$1'));
  }
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, asOf: Date.parse('2026-10-15T00:20:00Z') });
  assert.equal(r.ok, false); assert.deepEqual(r.pending, []); assert.equal(firstBad(r).reason, 'archive_mismatch');
});
test('an object with an earlier period than the one before it is archive_mismatch', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const files = walk(join(f.dir, 'ledgers/acme/audit')).filter((x) => x.endsWith('.jsonl.gz')).sort();
  renameSync(files[1], files[1].replace(/\/[^/]*?(-\d{12}-\d{12}\.jsonl\.gz)$/, '/20200101T0000Z$1'));
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.equal(r.ok, false); assert.equal(firstBad(r).reason, 'archive_mismatch');
});
const cli = async (extra) => {
  const f = await buildFixture({ entries: 5, periods: 1 });
  f.removeDigest(0);
  const key = join(f.dir, 'key.pem'); writeFileSync(key, f.publicKeyPem);
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../verify.mjs', import.meta.url)), '--dir', f.dir, '--store', 'acme/audit', '--public-key', key, ...extra], { encoding: 'utf8' });
  return r;
};
test('CLI: pending is INCOMPLETE and exits 3; each object is listed', async () => {
  const r = await cli(['--as-of', '2026-10-15T00:20:00Z']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /INCOMPLETE: 1 objects pending \(digest not written yet\)\n {2}\S+#\S+ seq 1-5/);
});
test('CLI: --strict turns pending into a failure (exit 1)', async () => {
  assert.equal((await cli(['--as-of', '2026-10-15T00:20:00Z', '--strict'])).status, 1);
});
for (const bad of ['2026-13-01T00:00:00Z', '2026-10-32T00:00:00Z', '2026-02-30T00:00:00Z', 'yesterday']) {
  test(`CLI: --as-of ${bad} is refused (exit 2)`, async () => {
    assert.equal((await cli(['--as-of', bad])).status, 2);
  });
}
test('a digest-listed object that is missing is reported', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.removeObject(1);
  const b = firstBad(await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem }));
  assert.deepEqual([b.reason, b.firstBrokenSeq], ['missing_entry', 5]);
});
test('two shards and two objects in one period verify independently', async () => {
  const f = await buildFixture({ entries: 6, periods: 1, shards: 2, objectsPerPeriod: 2 });
  let r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.equal(r.ok, true); assert.equal(r.shards.length, 2); assert.equal(r.entries, 12);
  f.rewriteLine(2, l => ({ ...l, value: '{"type":"plaintext","value":{"n":0}}' }), '01');
  r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.deepEqual(r.shards.map(s => [s.shard, s.ok]), [['00', true], ['01', false]]);
});

const wipeStore = (f) => {
  const dd = join(f.dir, 'digests/acme/audit');
  for (const n of readdirSync(dd)) if (n.endsWith('.json') || n.endsWith('.sig')) rmSync(join(dd, n));
  rmSync(join(f.dir, 'ledgers/acme'), { recursive: true });
};
const run = (f, anchorsDir) => verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir });

test('deleting every digest and object fails, flat anchors kept', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  wipeStore(f);
  const r = await run(f, f.anchorsDir);
  assert.equal(r.ok, false); assert.equal(r.anchors.mismatched.length, 2); assert.equal(r.store, 'acme/audit');
});
test('deleting every digest and object fails, <anchors>/<org>/<store> layout', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  const ext = mkdtempSync(join(tmpdir(), 'kvlv-anch-'));
  mkdirSync(join(ext, 'acme/audit'), { recursive: true });
  cpSync(f.anchorsDir, join(ext, 'acme/audit'), { recursive: true });
  wipeStore(f);
  const r = await run(f, ext);
  assert.equal(r.ok, false); assert.equal(r.anchors.mismatched.length, 2);
});
test('a store whose whole archive is gone is a failed result, not a crash', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  const ext = mkdtempSync(join(tmpdir(), 'kvlv-anch-'));
  cpSync(f.anchorsDir, ext, { recursive: true });
  rmSync(join(f.dir, 'digests/acme'), { recursive: true }); rmSync(join(f.dir, 'ledgers/acme'), { recursive: true });
  const r = await run(f, ext);
  assert.deepEqual([r.ok, r.reason], [false, 'archive_missing']);
  rmSync(join(f.dir, 'ledgers'), { recursive: true, force: true });
  assert.equal((await run(f)).ok, false);
});
test('an empty but present store archive verifies with 0 entries', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  wipeStore(f); mkdirSync(join(f.dir, 'ledgers/acme/audit'), { recursive: true });
  const r = await run(f);
  assert.deepEqual([r.ok, r.entries, r.shards], [true, 0, []]);
});
test('another store in the same root does not affect the named store', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  cpSync(join(f.dir, 'ledgers/acme/audit'), join(f.dir, 'ledgers/acme/other'), { recursive: true });
  const r = await run(f);
  assert.deepEqual([r.ok, r.entries], [true, 3]);
});
test('a bad store name is rejected', async () => {
  const f = await buildFixture({ entries: 1, periods: 1 });
  await assert.rejects(verifyArchive({ store: 'acme', dir: f.dir, publicKeyPem: f.publicKeyPem }), TypeError);
});
test('a garbled first line reports the object file range', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  f.garbleLine(0);
  const r = await run(f);
  assert.equal(r.shards[0].fromSeq, 1);
});

const withAnchors = async (f) => verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });

test('legacy anchors (no binding files) are reported as legacy mode', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  assert.equal((await withAnchors(f)).anchorMode, 'legacy');
});
test('bindings: an untouched archive verifies', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  const r = await withAnchors(f);
  assert.equal(r.ok, true); assert.equal(r.anchorMode, 'bindings');
  assert.equal(r.anchors.bindings, 2); assert.equal(r.anchors.checked, 2); assert.equal(r.anchors.boundDigests.length, 2);
  assert.deepEqual(r.anchors.mismatched, []);
});
test('bindings: a supplementary digest written after the anchor is uncovered until the next anchor', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  const i = f.addSupplementDigest();
  let r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.unanchoredDays, ['acme/audit/20261015']); assert.deepEqual(r.anchors.mismatched, []);
  f.anchorDigest(i);
  r = await withAnchors(f);
  assert.equal(r.ok, true); assert.equal(r.anchors.boundDigests.at(-1).digestKey.endsWith('_000001.json'), true);
});
test('bindings: a binding bound to a later digest covers the earlier ones through the chain', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.editBinding(0, (b) => b); // keep day 1 binding as is
  const i = f.addSupplementDigest();
  f.anchorDigest(i);
  assert.equal((await withAnchors(f)).anchors.unanchoredDays, undefined);
});
test('legacy binding (no types) with no token is typed customer-bucket: unwitnessed, digests uncovered', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, legacyBindings: true });
  f.removeAnchor(1);
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.unwitnessed, [{ day: '20261015', type: 'customer-bucket', reason: 'customer_copy_not_provided' }]);
  assert.deepEqual(r.anchors.unanchoredDays, ['acme/audit/20261015']);
  assert.equal(r.anchors.boundDigests.length, 1);
});
test('bindings: a binding that lists rfc3161 but has no token fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.removeAnchor(1);
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.details.map((d) => d.reason), ['binding_without_token']);
});
for (const [label, types] of [['empty', []], ['unknown', ['rfc3161', 'zzz']], ['unsorted', ['rfc3161', 'customer-bucket']], ['duplicate', ['rfc3161', 'rfc3161']], ['not a list', 'rfc3161']]) {
  test(`bindings: an invalid types list (${label}) is a bad binding`, async () => {
    const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
    f.editBinding(1, (b) => ({ ...b, types }));
    assert.deepEqual((await withAnchors(f)).anchors.details.map((d) => d.reason), ['bad_binding']);
  });
}
test('bindings: both types — the token covers, the missing customer copy is listed as unwitnessed', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, types: ['customer-bucket', 'rfc3161'] });
  const r = await withAnchors(f);
  assert.equal(r.ok, true); assert.equal(r.anchors.unwitnessed.length, 2); assert.equal(r.anchors.unanchoredDays, undefined);
});
test('bindings: both types with matching copies verify with nothing unwitnessed', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, types: ['customer-bucket', 'rfc3161'] });
  const r = await withCopies(f, f.makeCopies());
  assert.equal(r.ok, true); assert.equal(r.anchors.unwitnessed, undefined);
});
test('bindings: both types — a differing copy fails even when the token is fine', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, types: ['customer-bucket', 'rfc3161'] });
  const copies = f.makeCopies();
  rmSync(join(copies, 'acme/audit/anchors/20261015.anchor.json'));
  const r = await withCopies(f, copies);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.some((d) => d.reason === 'binding_copy_missing'));
});
test('a mutated real TSA token is a bad_token_signature', async () => {
  const real = Buffer.from(readFileSync(new URL('../fixtures/digicert-timestamp.tsr', import.meta.url)));
  real[real.length - 10] ^= 1;
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, tokenBytes: real });
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.every((d) => d.reason === 'bad_token_signature')); assert.equal(r.anchorTokenCheck, 'signature');
});
test('a real DigiCert token for another digest is a token_imprint_differs (signature passes first)', async () => {
  const real = readFileSync(new URL('../fixtures/digicert-timestamp.tsr', import.meta.url));
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, tokenBytes: real });
  const r = await verifyArchive({ store: 'acme/audit', dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });
  assert.ok(r.anchors.details.every((d) => d.reason === 'token_imprint_differs')); assert.equal(r.anchorTokenCheck, 'signature');
});
test('bindings: tokens signed by the (test) TSA verify with the signature check', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  const r = await withAnchors(f);
  assert.equal(r.ok, true); assert.equal(r.anchorTokenCheck, 'signature');
});
test('junk that carries the right imprint bytes fails as bad_token_signature', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true,
    tokenBytes: (hash) => Buffer.concat([Buffer.from('fake-tsr'), Buffer.from('06096086480165030402010500' + '0420', 'hex'), Buffer.from(hash, 'hex')]) });
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.every((d) => d.reason === 'bad_token_signature'));
});
test('a token from a TSA that does not chain to the trusted roots fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  const r = await verifyArchive({ store: 'acme/audit', dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir });
  assert.equal(r.ok, false); assert.ok(r.anchors.details.every((d) => d.reason === 'bad_token_signature'));
});
test('bindings: a token with no binding fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.removeBinding(1);
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.details.map((d) => d.reason), ['token_without_binding']);
});
test('bindings: a binding that points at a digest not in the chain fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.editBinding(1, (b) => ({ ...b, digestKey: 'digests/acme/audit/20261020T0000Z.json' }));
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.details.map((d) => d.reason), ['digest_not_in_chain']);
});
test('bindings: a digest hash that differs from the digest file fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.editBinding(1, (b) => ({ ...b, digestHash: 'a'.repeat(64) }));
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.details.map((d) => d.reason), ['digest_hash_differs']);
});
test('bindings: a malformed binding fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.editBinding(1, (b) => ({ ...b, v: 2 }));
  assert.deepEqual((await withAnchors(f)).anchors.details.map((d) => d.reason), ['bad_binding']);
});
test('bindings: a token whose imprint is not the bound digest fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true });
  f.corruptAnchor(1);
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.deepEqual(r.anchors.details.map((d) => d.reason), ['token_imprint_differs']);
});

const withCopies = (f, copies) => verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, anchorsDir: f.anchorsDir, anchorCopiesDir: copies });

test('customer-bucket: copies that match verify', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const r = await withCopies(f, f.makeCopies());
  assert.equal(r.ok, true); assert.equal(r.anchors.unwitnessed, undefined); assert.equal(r.anchors.boundDigests.length, 2);
});
test('customer-bucket: copies not provided leave the bindings unwitnessed and the digests uncovered', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const r = await withAnchors(f);
  assert.equal(r.ok, false); assert.equal(r.anchors.unwitnessed.length, 2); assert.equal(r.anchors.unanchoredDays.length, 2);
  assert.deepEqual(r.anchors.mismatched, []);
});
test('customer-bucket: an archive rewritten after anchoring differs from the copy', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const copies = f.makeCopies();
  f.editDigestUnsigned(1, (d) => ({ ...d, signedAt: 'later' }));
  const r = await withCopies(f, copies);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.some((d) => d.reason === 'copy_differs'));
});
test('customer-bucket: a digest in the copy but not in the archive fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const copies = f.makeCopies();
  f.truncateLastPeriod();
  const r = await withCopies(f, copies);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.some((d) => d.reason === 'copy_not_in_archive'));
});
test('customer-bucket: a missing binding copy fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const copies = f.makeCopies();
  rmSync(join(copies, 'acme/audit/anchors/20261015.anchor.json'));
  const r = await withCopies(f, copies);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.some((d) => d.reason === 'binding_copy_missing'));
});
test('customer-bucket: a digest missing from the copy fails', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, bindings: true, customer: true });
  const copies = f.makeCopies();
  rmSync(join(copies, 'acme/audit/20261015T0000Z.json.sig'));
  const r = await withCopies(f, copies);
  assert.equal(r.ok, false); assert.ok(r.anchors.details.some((d) => d.reason === 'copy_missing_digest'));
});

// Ruling F10: a fork (two objects that hold one seq) is archive_mismatch at the first shared seq,
// with the range of the object listed later, before any digest check.
import { gunzipSync, gzipSync } from 'node:zlib';
function shardDir(dir) {
  const ledger = join(dir, 'ledgers', 'acme', 'audit');
  const walkTo = (p, depth) => (depth === 0 ? p : walkTo(join(p, readdirSync(p).sort()[0]), depth - 1));
  return walkTo(ledger, 3);
}
function addObject(dir, name, fromSeq, toSeq) {
  const sd = shardDir(dir);
  const lines = readdirSync(sd).sort().flatMap((n) => gunzipSync(readFileSync(join(sd, n))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const pick = lines.filter((l) => l.seq >= fromSeq && l.seq <= toSeq);
  writeFileSync(join(sd, name), gzipSync(pick.map((l) => JSON.stringify(l) + '\n').join('')));
}
test('F10: a second object for archived seqs is archive_mismatch at the first shared seq, with its range', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  addObject(f.dir, '20261020T0000Z-000000000001-000000000003.jsonl.gz', 1, 3);
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  const bad = firstBad(r);
  assert.deepEqual([r.ok, bad.reason, bad.firstBrokenSeq, bad.objectFromSeq, bad.objectToSeq], [false, 'archive_mismatch', 1, 1, 3]);
});
test('F10: the fork is the object listed later, also when its fromSeq is lower; the first shared seq is reported', async () => {
  const f = await buildFixture({ entries: 7, periods: 2 });
  // Listed after both real objects; holds 3..6, which shares 3.. with the first object and 5.. with the second.
  addObject(f.dir, '20261020T0000Z-000000000003-000000000006.jsonl.gz', 3, 6);
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  const bad = firstBad(r);
  assert.deepEqual([bad.reason, bad.firstBrokenSeq, bad.objectFromSeq, bad.objectToSeq], ['archive_mismatch', 3, 3, 6]);
});

// Review item 6: only the archive job writes under a ledger's archive prefix, so any other name fails.
test('a key the archive job never writes, inside a shard folder, fails that shard at seq 1', async () => {
  for (const name of ['notes.txt', 'x20261020T0000Z-000000000001-000000000001.jsonl.gz', '20261020T0000Z-000000000000-000000000001.jsonl.gz']) {
    const f = await buildFixture({ entries: 7, periods: 2 });
    writeFileSync(join(shardDir(f.dir), name), 'x');
    const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
    assert.deepEqual([r.ok, firstBad(r).reason, firstBad(r).firstBrokenSeq], [false, 'archive_mismatch', 1], name);
  }
});
test('a non-canonical collection folder, a bad shard folder and a stray key are failed results of their own', async () => {
  const f = await buildFixture({ entries: 3, periods: 1 });
  const ledger = join(f.dir, 'ledgers', 'acme', 'audit', readdirSync(join(f.dir, 'ledgers', 'acme', 'audit'))[0]);
  const enc = readdirSync(ledger)[0];
  mkdirSync(join(ledger, 'not*base64', '00'), { recursive: true }); writeFileSync(join(ledger, 'not*base64', '00', 'a.jsonl.gz'), 'x');
  mkdirSync(join(ledger, enc, '7x'), { recursive: true }); writeFileSync(join(ledger, enc, '7x', 'f'), 'x');
  writeFileSync(join(ledger, 'stray'), 'x');
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  const junk = r.shards.filter(s => !/^\d{2}$/.test(s.shard)).map(s => [s.collection, s.shard, s.reason, s.firstBrokenSeq]).sort();
  const coll = Buffer.from(enc, 'base64url').toString('utf8');
  assert.deepEqual(junk, [[coll, '7x', 'archive_mismatch', 1], ['not*base64', '', 'archive_mismatch', 1], ['stray', '', 'archive_mismatch', 1]].sort());
  assert.equal(r.ok, false);
});

// Provenance: the source is inside the hashed stored value, so the verifier checks it with no new rule.
test('an archive of old entries (no source) followed by entries with a source verifies', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, sources: 4 });
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, receipts: f.receipts });
  assert.equal(r.ok, true); assert.equal(r.entries, 7);
});
for (const [label, edit] of [
  ['a rewritten source principal', (v) => v.replace('acme/gov-ai/fn-1', 'acme/gov-ai/other-fn')],
  ['a source type rewritten to platform', (v) => v.replace('"type":"edge"', '"type":"platform"')],
  ['a source removed', (v) => v.replace(/,"source":\{[^}]*\}/, '')],
]) {
  test(`detects: ${label}`, async () => {
    const f = await buildFixture({ entries: 7, periods: 2, sources: 1 });
    await f.rewriteLine(5, l => ({ ...l, value: edit(l.value) }));
    const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
    assert.equal(r.ok, false);
    assert.deepEqual([firstBad(r).reason, firstBad(r).firstBrokenSeq], ['hash_mismatch', 5]);
  });
}
test('a source added to an old entry after the fact is detected', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, sources: 6 });
  await f.rewriteLine(2, l => ({ ...l, value: JSON.stringify({ ...JSON.parse(l.value), source: { type: 'platform', principal: 'quant-ledger' } }) }));
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.deepEqual([r.ok, firstBad(r).reason, firstBad(r).firstBrokenSeq], [false, 'hash_mismatch', 2]);
});

test('the result counts entries per source, and lists each entry with its source on request', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, sources: 4 });
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem, listEntries: true });
  assert.deepEqual(r.sources, [{ source: { type: 'edge', principal: 'acme/gov-ai/fn-1' }, entries: 4 }, { source: null, entries: 3 }]);
  assert.equal(r.entryList.length, 7);
  assert.deepEqual(r.entryList.map(e => e.source?.type ?? null), [null, null, null, 'edge', 'edge', 'edge', 'edge']);
  const plain = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.equal(plain.entryList, undefined);
});
test('a forged source is never counted: only entries whose hash verifies are', async () => {
  const f = await buildFixture({ entries: 7, periods: 2, sources: 1 });
  await f.rewriteLine(5, l => ({ ...l, value: l.value.replace('acme/gov-ai/fn-1', 'acme/gov-ai/other-fn') }));
  const r = await verifyArchive({ store: 'acme/audit', tsaRootsPem: TEST_ROOTS, dir: f.dir, publicKeyPem: f.publicKeyPem });
  assert.deepEqual(r.sources, [{ source: { type: 'edge', principal: 'acme/gov-ai/fn-1' }, entries: 6 }]);
});
test('the CLI prints the per-source summary and, with --list-entries, each entry with its source', async () => {
  const f = await buildFixture({ entries: 3, periods: 1, sources: 2 });
  const key = join(f.dir, 'key.pem'); writeFileSync(key, f.publicKeyPem);
  const run = (...extra) => spawnSync(process.execPath, [fileURLToPath(new URL('../verify.mjs', import.meta.url)), '--dir', f.dir, '--store', 'acme/audit', '--public-key', key, ...extra], { encoding: 'utf8' });
  const out = run().stdout;
  assert.match(out, /sources \(entries whose hash verifies\):/);
  assert.match(out, /\s2\s+edge acme\/gov-ai\/fn-1/);
  assert.match(out, /\s1\s+\(none: before provenance\)/);
  const listed = run('--list-entries').stdout;
  assert.match(listed, /entry ai-use:\S+ seq 1 \S+ [0-9a-f]{64} -/);
  assert.match(listed, /entry ai-use:\S+ seq 3 \S+ [0-9a-f]{64} edge acme\/gov-ai\/fn-1/);
});
