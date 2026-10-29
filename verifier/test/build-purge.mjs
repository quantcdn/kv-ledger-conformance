// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Builds a signed archive purge receipt with its manifest pages over a small archive fixture.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildFixture } from './build-fixture.mjs';
import { canonicalJson } from '../lib/jcs.mjs';

const ORG = 'acme', STORE = 'audit', PURGE_ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function filesUnder(root, prefix) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(join(root, prefix));
  return out;
}

function manifestLines(dir) {
  const keys = [...filesUnder(dir, `ledgers/${ORG}/${STORE}`), ...filesUnder(dir, `digests/${ORG}/${STORE}`)].sort(byteOrder);
  return keys.map((key, i) => {
    const bytes = readFileSync(join(dir, key));
    return { key, size: statSync(join(dir, key)).size, line: canonicalJson({ keySha256: sha(key), versionId: `v-${i}`, sha256: sha(bytes), size: bytes.length,
      lockMode: 'governance', retainUntil: '2026-10-20T00:00:00Z', lastModified: '2026-10-14T00:00:00Z' }) };
  });
}

function newestDigestHash(dir) {
  const root = join(dir, 'digests', ORG, STORE);
  const names = readdirSync(root).filter((n) => n.endsWith('.json')).sort(byteOrder);
  return { name: names[names.length - 1], hash: sha(readFileSync(join(root, names[names.length - 1]))) };
}

function pagesOf(lines, pageLines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += pageLines) pages.push(lines.slice(i, i + pageLines));
  return pages;
}

export async function buildPurge({ pageLines = 10_000 } = {}) {
  const fx = await buildFixture({ entries: 12, periods: 3, bindings: true });
  const lines = manifestLines(fx.dir);
  const out = mkdtempSync(join(tmpdir(), 'kv-purge-'));
  const pageFiles = pagesOf(lines, pageLines).map((page, i) => {
    const name = `manifest-${String(i + 1).padStart(5, '0')}.jsonl.gz`, bytes = gzipSync(page.map((l) => l.line + '\n').join(''));
    writeFileSync(join(out, name), bytes);
    return { name, file: join(out, name), count: page.length, sha256: sha(bytes) };
  });
  const manifest = pageFiles.map((p) => ({ key: `purge-receipts/${ORG}/${PURGE_ID}/${p.name}`, versionId: `pv-${p.name}`, sha256: p.sha256, count: p.count }));
  const digestsOf = lines.filter((l) => l.key.startsWith('digests/'));
  const last = newestDigestHash(fx.dir);
  const count = (re) => lines.filter((l) => re.test(l.key)).length;
  const receipt = {
    v: 1, type: 'kv-ledger-archive-purge-receipt', purgeId: PURGE_ID, org: ORG, store: STORE, scope: 'store', requestedBy: 'user:12',
    requestedAt: '2026-10-24T00:00:00.000Z', completedAt: '2026-10-24T01:00:00.000Z',
    storeRecord: { deletedAt: '2026-10-22T00:00:00.000Z', ledgers: [{ name: 'aiUse', definitionHash: sha('def'), lockMode: 'governance', retentionDays: 2555 }], source: 'tombstone' },
    chain: { digestCount: digestsOf.filter((l) => l.key.endsWith('.json')).length, firstDigest: 'first', lastDigest: last.name.replace(/\.json$/, ''), lastDigestHash: last.hash, anchorDays: 1 },
    objects: { count: lines.length, bytes: lines.reduce((n, l) => n + l.size, 0), ledgerObjects: count(/^ledgers\//), digestObjects: count(/^digests\/.*\.json(\.sig)?$/),
      anchorObjects: count(/^digests\/.*\/anchors\//), latestRetainUntil: '2026-10-20T00:00:00Z', manifest, manifestSha256: sha(canonicalJson(manifest)) },
    emptiness: { prefixes: [`ledgers/${ORG}/${STORE}/`, `digests/${ORG}/${STORE}/`], checkedAt: '2026-10-24T00:59:00.000Z', versions: 0, deleteMarkers: 0 },
    subjectKeyRowsDeleted: 0,
    residual: [{ kind: 'dynamodb-pitr-system-backup', until: '2026-11-26T00:00:00.000Z' }, { kind: 'subject-key-pitr', until: '2026-11-28T01:00:00.000Z' },
      { kind: 'registry-pitr', until: '2026-11-28T01:00:00.000Z' }, { kind: 'kv-export-files', until: '2026-10-29T00:00:00.000Z' }],
    keyId: 'arn:k1', signedAt: '2026-10-24T01:00:01.000Z',
  };
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const receiptFile = join(out, 'receipt.json'), keysFile = join(out, 'keys.json');
  const b = { dir: fx.dir, org: ORG, store: STORE, receiptFile, pageFiles, keysFile, privateKey, receipt, receiptDoc: undefined, lastDigest: last.name.replace(/\.json$/, '') };
  const write = (signed) => {
    const json = canonicalJson(b.receipt);
    b.receiptDoc = { json, signature: signed ? sign('sha256', Buffer.from(json, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64') : b.receiptDoc.signature,
      keyId: 'arn:k1', algorithm: 'ECDSA_SHA_256' };
    writeFileSync(receiptFile, JSON.stringify(b.receiptDoc));
  };
  write(true);
  writeFileSync(keysFile, JSON.stringify({ keyId: 'arn:k1', publicKeyPem }));
  b.publicKeyPem = publicKeyPem;
  b.edit = (fn) => { fn(b.receipt); write(false); };
  b.resign = () => write(true);
  return b;
}
