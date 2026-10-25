// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Builds one saved inclusion proof from the published test vectors (vectors/ledger-vectors.json), signed with a fresh
// test key, plus the anchor files an auditor would download. Test only.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../lib/jcs.mjs';
import { sha256Hex } from '../lib/hash.mjs';
import { auditPath, merkleRoot } from '../lib/merkle.mjs';
import { makeToken } from './make-token.mjs';

export const VECTORS = JSON.parse(readFileSync(new URL('../../vectors/ledger-vectors.json', import.meta.url), 'utf8'));
const V = VECTORS;
const KEY_ID = 'test-ledger-key';
const PREFIX = `digests/${V.org}/${V.store}/`;
const ARCHIVE_KEY = `ledgers/${V.org}/${V.store}/${V.definition.name}/${Buffer.from(V.collection).toString('base64url')}/${V.shard}/20261016T0300Z-000000000001-000000000005.jsonl.gz`;
const NAMES = ['20261016T0300Z', '20261016T0305Z', '20261016T0310Z'];
const DAY = '20261016';

const lineOf = (e) => ({ key: `ai-use:agency-42:${e.id}`, collection: V.collection, shard: V.shard, id: e.id, seq: e.seq, at: e.at, value: e.stored, prevHash: e.prevHash, hash: e.hash });
const bytesOf = (d) => Buffer.from(canonicalJson(d), 'utf8');

function firstDigest(root) {
  const last = V.entries[V.entries.length - 1];
  return { v: 1, org: V.org, store: V.store, period: { start: '2026-10-16T03:00:00.000Z', end: '2026-10-16T03:05:00.000Z' }, prevDigestHash: V.digestGenesisPrevHash,
    ledgers: [{ name: V.definition.name, definition: JSON.parse(JSON.stringify(V.definition)), definitionHash: V.definitionHash,
      instances: [{ archiveKey: ARCHIVE_KEY, collection: V.collection, shard: V.shard, fromSeq: 1, toSeq: 5, headHash: last.hash, merkleRoot: root }] }],
    signedAt: '2026-10-16T03:06:12.000Z' };
}

// The digest chain: the proof's digest, then `later` empty digests that each link to the one before.
function chain(later) {
  const hashes = V.entries.map((e) => e.hash);
  const digests = [{ name: NAMES[0], digest: firstDigest(merkleRoot(hashes)) }];
  for (let i = 1; i <= later; i++) {
    const prev = digests[i - 1].digest;
    digests.push({ name: NAMES[i], digest: { ...prev, ledgers: [], prevDigestHash: sha256Hex(bytesOf(prev)), signedAt: `2026-10-16T03:1${i}:00.000Z` } });
  }
  return digests;
}

function writeDigests(dir, digests, privateKey) {
  mkdirSync(join(dir, 'anchors'), { recursive: true });
  for (const d of digests) {
    const signature = sign('sha256', bytesOf(d.digest), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
    writeFileSync(join(dir, `${d.name}.json`), bytesOf(d.digest));
    writeFileSync(join(dir, `${d.name}.json.sig`), JSON.stringify({ v: 1, keyId: KEY_ID, algorithm: 'ECDSA_SHA_256', signature }));
    d.signature = signature;
  }
}

function writeAnchor(storeDir, bound, types) {
  const digestHash = sha256Hex(bytesOf(bound.digest));
  const binding = canonicalJson({ v: 1, types, digestKey: `${PREFIX}${bound.name}.json`, digestHash, anchoredAt: '2026-10-17T00:10:00.000Z' });
  writeFileSync(join(storeDir, 'anchors', `${DAY}.anchor.json`), binding);
  if (types.includes('rfc3161')) writeFileSync(join(storeDir, 'anchors', `${DAY}.tsr`), makeToken(digestHash));
  return { binding, digestHash };
}

// options: index (leaf 0..4), later (digests after the proof's digest, 0..2), types (binding anchor types), copies (write the
// customer-bucket copy). Returns the proof, its entry, the key files and the anchor directories.
export function buildProof({ index = 0, later = 0, types = ['rfc3161'], copies = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kvlv-proof-'));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const digests = chain(later);
  const storeDir = join(dir, 'archive', 'digests', V.org, V.store);
  writeDigests(storeDir, digests, privateKey);
  const anchor = writeAnchor(storeDir, digests[digests.length - 1], types);
  const copiesRoot = join(dir, 'copies');
  if (copies) {
    const to = join(copiesRoot, V.org, V.store);
    writeDigests(to, digests, privateKey);
    writeFileSync(join(to, 'anchors', `${DAY}.anchor.json`), anchor.binding);
  }
  const hashes = V.entries.map((e) => e.hash), line = lineOf(V.entries[index]), first = digests[0];
  const proof = { status: 'archived', entry: line, hash: line.hash, period: NAMES[0], archiveKey: ARCHIVE_KEY, merkleRoot: merkleRoot(hashes), auditPath: auditPath(index, hashes),
    treeSize: hashes.length, leafIndex: index, digestKey: `${PREFIX}${first.name}.json`, digest: first.digest, signature: first.signature, keyId: KEY_ID,
    digestSignedAt: first.digest.signedAt, anchor: { type: types[0], day: DAY, bindingKey: `${PREFIX}anchors/${DAY}.anchor.json`, ...(types.includes('rfc3161') ? { tokenKey: `${PREFIX}anchors/${DAY}.tsr` } : {}) } };
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, 'key.pem'), publicKeyPem);
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({ keyId: KEY_ID, publicKeyPem, keys: [{ keyId: KEY_ID, publicKeyPem, current: true }] }));
  return { dir, proof, entry: line, publicKeyPem, keyFile: join(dir, 'key.pem'), keysFile: join(dir, 'keys.json'), anchorDir: join(storeDir, 'anchors'), storeDir,
    copiesDir: copiesRoot, digestHash: anchor.digestHash, names: NAMES.slice(0, later + 1) };
}
