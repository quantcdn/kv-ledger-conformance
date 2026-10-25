// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalJson } from '../lib/jcs.mjs';
import { sha256Hex } from '../lib/hash.mjs';
import { purgeCheck } from '../lib/purge.mjs';
import { buildPurge } from './build-purge.mjs';

const CLI = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const PAGE1 = 'manifest-00001.jsonl.gz';

const run = (p, { pages = p.pageFiles.map((f) => f.file), receipt = p.receiptFile, dir = p.dir, keyArgs = ['--public-keys', p.keysFile] } = {}) =>
  spawnSync(process.execPath, [CLI, 'purge-check', dir, receipt, ...pages, ...keyArgs], { encoding: 'utf8' });
const lines = (r) => r.stdout.split('\n').filter(Boolean);
const rehash = (r) => { r.objects.manifestSha256 = sha256Hex(canonicalJson(r.objects.manifest)); };
const small = () => buildPurge({ pageLines: 10 });
function expectExit1(r, wanted) {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(lines(r).includes(wanted), `wanted "${wanted}" in:\n${r.stdout}`);
  assert.match(lines(r).at(-1), /^NOT CONFIRMED: \d+ problem\(s\)$/);
}
const objectFile = (dir) => {
  const root = join(dir, 'ledgers', 'acme', 'audit');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(root).find((f) => f.endsWith('.jsonl.gz'));
};

test('a matching handoff, receipt and pages: exit 0', async () => {
  const p = await small();
  const r = run(p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [first] = lines(r);
  assert.match(first, new RegExp(`^OK purge ${p.receipt.purgeId} acme/audit: ${p.receipt.objects.count} handoff files in the manifest, ${p.pageFiles.length} pages, ${p.receipt.objects.count} lines, newest digest matches$`));
  assert.ok(lines(r).slice(1).join(' ').includes('This holds when your handoff copy passes verify.'));
  assert.ok(!r.stdout.includes('Run purge-check to bind it'));
  assert.ok(p.pageFiles.length > 1);
});

test('the default page size (10,000 lines) works with one page', async () => {
  const p = await buildPurge();
  assert.equal(run(p).status, 0);
});

test('a bad receipt signature is exit 1 (R4)', async () => {
  const p = await small();
  p.edit((r) => { r.subjectKeyRowsDeleted = 1; });
  expectExit1(run(p), 'signature invalid: bad signature');
});

test('a receipt of another type is exit 1', async () => {
  const p = await small();
  const report = { v: 1, type: 'kv-ledger-verification-report', org: 'acme', store: 'audit', ledger: 'aiUse', id: '01M5104A000000000000000000',
    at: '2026-10-16T16:20:00.000Z', startedAt: '2026-10-16T16:17:00.000Z', trigger: 'api', scope: {}, complete: true, ok: true, entries: 9, shardsFailed: 0, failures: [] };
  const json = canonicalJson(report);
  writeFileSync(p.receiptFile, JSON.stringify({ json, keyId: 'arn:k1', algorithm: 'ECDSA_SHA_256', signature: sign('sha256', Buffer.from(json), { key: p.privateKey, dsaEncoding: 'der' }).toString('base64') }));
  expectExit1(run(p), 'not an archive purge receipt');
});

test('a page with one changed byte is exit 1 and is not parsed (R5)', async () => {
  const p = await small();
  const bytes = readFileSync(p.pageFiles[0].file);
  bytes[bytes.length - 12] ^= 1;
  writeFileSync(p.pageFiles[0].file, bytes);
  expectExit1(run(p), `page ${PAGE1}: sha256 differs from the receipt`);
});

test('a page whose line count differs is exit 1', async () => {
  const p = await small();
  const n = p.receipt.objects.manifest[0].count;
  p.edit((r) => { r.objects.manifest[0].count += 1; rehash(r); }); p.resign();
  expectExit1(run(p), `page ${PAGE1}: ${n} lines, receipt says ${n + 1}`);
});

test('a missing page and an extra page file are exit 1', async () => {
  const p = await small();
  const extra = join(dirname(p.receiptFile), 'manifest-00009.jsonl.gz');
  copyFileSync(p.pageFiles[0].file, extra);
  const r = run(p, { pages: [p.pageFiles[0].file, extra] });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(lines(r).includes('page manifest-00002.jsonl.gz: not given'));
  assert.ok(lines(r).includes('page manifest-00009.jsonl.gz: not in the receipt'));
});

test('manifestSha256 that does not match is exit 1', async () => {
  const p = await small();
  p.edit((r) => { r.objects.manifestSha256 = sha256Hex('x'); }); p.resign();
  const r = run(p);
  assert.equal(r.status, 1);
  assert.ok(lines(r)[0].startsWith('signature invalid: malformed purge receipt: '));
});

test('a handoff file not in the manifest is exit 1', async () => {
  const p = await small();
  const dir = dirname(objectFile(p.dir));
  writeFileSync(join(dir, 'extra.jsonl.gz'), gzipSync('x'));
  const key = join(dir, 'extra.jsonl.gz').slice(p.dir.length + 1).split('\\').join('/');
  expectExit1(run(p), `handoff ${key}: not in the manifest`);
});

test('a handoff file with changed content is exit 1', async () => {
  const p = await small();
  const f = objectFile(p.dir);
  writeFileSync(f, gzipSync('changed'));
  expectExit1(run(p), `handoff ${f.slice(p.dir.length + 1).split('\\').join('/')}: content sha256 not in the manifest`);
});

test('a handoff whose newest digest differs is exit 1', async () => {
  const p = await small();
  const name = '99991231T2359Z.json';
  writeFileSync(join(p.dir, 'digests', 'acme', 'audit', name), '{}');
  expectExit1(run(p), `newest digest ${name}: sha256 differs from chain.lastDigestHash`);
});

test('a handoff without a digest is exit 1', async () => {
  const p = await small();
  const { rmSync } = await import('node:fs');
  for (const n of readdirSync(join(p.dir, 'digests', 'acme', 'audit'))) if (n.endsWith('.json')) rmSync(join(p.dir, 'digests', 'acme', 'audit', n));
  const r = run(p);
  assert.equal(r.status, 1);
  assert.ok(lines(r).includes('handoff has no digest for acme/audit'));
});

test('page counts that do not add up to objects.count are exit 1 (R7)', async () => {
  const p = await small();
  p.edit((r) => { r.objects.count += 1; }); p.resign();
  const r = run(p);
  assert.equal(r.status, 1);
  assert.ok(lines(r).some((l) => /^page counts: the pages add up to \d+ lines, objects\.count is \d+$/.test(l)), r.stdout);
});

test('a symlink in the handoff is exit 1 (not a regular file)', async () => {
  const p = await small();
  const link = join(dirname(objectFile(p.dir)), 'link.jsonl.gz');
  symlinkSync(objectFile(p.dir), link);
  expectExit1(run(p), `handoff ${link.slice(p.dir.length + 1).split('\\').join('/')}: not a regular file`);
});

test('a handoffDir that is missing or a file is exit 2', async () => {
  const p = await small();
  assert.equal(run(p, { dir: join(p.dir, 'nope') }).status, 2);
  assert.equal(run(p, { dir: p.receiptFile }).status, 2);
});

test('files of another store in the handoff are ignored', async () => {
  const p = await small();
  const other = join(p.dir, 'ledgers', 'acme', 'other', 'aiUse', 'x', '00');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'junk.jsonl.gz'), gzipSync('x'));
  assert.equal(run(p).status, 0);
});

test('malformed input is exit 2', async () => {
  const p = await small();
  assert.equal(run(p, { receipt: join(p.dir, 'nope.json') }).status, 2);
  const notJson = join(dirname(p.receiptFile), 'bad.json');
  writeFileSync(notJson, 'not json');
  assert.equal(run(p, { receipt: notJson }).status, 2);
  assert.equal(run(p, { keyArgs: [] }).status, 2);
  const pem = join(dirname(p.receiptFile), 'k.pem');
  writeFileSync(pem, p.publicKeyPem);
  assert.equal(run(p, { keyArgs: ['--public-key', pem, '--public-keys', p.keysFile] }).status, 2);
  assert.equal(run(p, { pages: [join(p.dir, 'nope.gz')] }).status, 2);
});

test('a page that matches its hash but is not gzip, or holds a non-object line, is exit 2', async () => {
  for (const bytes of [Buffer.from('plain text'), gzipSync('[1]\n')]) {
    const p = await small();
    writeFileSync(p.pageFiles[0].file, bytes);
    p.edit((r) => { r.objects.manifest[0].sha256 = sha256Hex(bytes); rehash(r); }); p.resign();
    const r = run(p);
    assert.equal(r.status, 2, r.stdout + r.stderr);
  }
});

test('purgeCheck returns ok, a summary and no problems for a matching set', async () => {
  const p = await small();
  const r = purgeCheck({ handoffDir: p.dir, receiptDoc: p.receiptDoc, pages: p.pageFiles.map((f) => ({ name: f.name, bytes: readFileSync(f.file) })), keys: p.publicKeyPem });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.badInput, false);
  assert.equal(r.summary.lines, p.receipt.objects.count);
});

test('no output line contains manifest or file content (R9)', async () => {
  const cases = [
    async () => { const p = await small(); p.edit((r) => { r.reason = 'x'; }); return p; },
    async () => { const p = await small(); writeFileSync(objectFile(p.dir), gzipSync('changed')); return p; },
    async () => { const p = await small(); writeFileSync(join(dirname(objectFile(p.dir)), 'extra.jsonl.gz'), gzipSync('x')); return p; },
    async () => { const p = await small(); const b = readFileSync(p.pageFiles[0].file); b[b.length - 12] ^= 1; writeFileSync(p.pageFiles[0].file, b); return p; },
  ];
  for (const make of cases) {
    const p = await make();
    const r = run(p);
    assert.equal(r.status, 1);
    const hashes = gunzipSync(readFileSync(p.pageFiles[1].file)).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l).keySha256);
    for (const l of lines(r)) {
      assert.ok(!l.includes('{'), l);
      assert.ok(!hashes.some((h) => l.includes(h)), l);
    }
  }
});
