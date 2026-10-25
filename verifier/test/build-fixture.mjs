// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Builds a small signed archive in a temporary directory, with helpers that tamper with it.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { makeToken, TEST_ROOT_PEM } from './make-token.mjs';
import { canonicalJson } from '../lib/jcs.mjs';
import { digestGenesisHash, entryHash, genesisHash, instanceName, sha256Hex } from '../lib/hash.mjs';
import { merkleRoot } from '../lib/merkle.mjs';

const ORG = 'acme', STORE = 'audit', LEDGER = 'aiUse', COLLECTION = 'ai-use:agency-42';
const PERIOD_MS = 300000;
const FIRST_PERIOD = Date.UTC(2026, 9, 14, 23, 55); // period 2 starts at midnight, so two days are anchored
const DEFINITION = { v: 1, name: LEDGER, collection: 'ai-use:*', chains: 1, retentionDays: 2555, lockMode: 'governance', personalFields: [], anchor: { type: 'none' }, createdAt: '2026-10-14T00:00:00.000Z' };

const pad12 = (n) => String(n).padStart(12, '0');
const label = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/(\d{8}T\d{4})\d{2}Z/, '$1Z');
const bytesOf = (digest) => Buffer.from(canonicalJson(digest), 'utf8');

// sources: from this seq on, each entry records its writer (provenance) as the last field of the stored value.
const SOURCE = { type: 'edge', principal: 'acme/gov-ai/fn-1' };
const storedOf = (seq, sources) => JSON.stringify(sources !== undefined && seq >= sources
  ? { type: 'plaintext', value: { n: seq }, source: SOURCE } : { type: 'plaintext', value: { n: seq } });
function makeLines(n, from, prev, instance, shard, sources) {
  const lines = [];
  for (let seq = from; seq < from + n; seq++) {
    const l = { key: `id-${shard}-${seq}`, collection: COLLECTION, shard, id: `01M5104A${String(seq).padStart(18, '0')}-${shard}`, seq, at: 1792108800000 + seq * 1000,
      value: storedOf(seq, sources), prevHash: prev };
    l.hash = entryHash({ prevHash: l.prevHash, instance, seq, id: l.id, at: l.at, stored: l.value });
    lines.push(l); prev = l.hash;
  }
  return lines;
}

function split(entries, parts) {
  const per = Math.ceil(entries / parts), sizes = [];
  for (let left = entries; left > 0; left -= per) sizes.push(Math.min(per, left));
  return sizes;
}

const shardName = (i) => String(i).padStart(2, '0');
const objName = (o) => `${label(o.period)}-${pad12(o.lines[0].seq)}-${pad12(o.lines[o.lines.length - 1].seq)}.jsonl.gz`;

function buildObjects({ entries, periods, shards, objectsPerPeriod, sources }, definitionHash) {
  const objects = [];
  for (let sh = 0; sh < shards; sh++) {
    const shard = shardName(sh), instance = instanceName(ORG, STORE, COLLECTION, shard);
    let prev = genesisHash(instance, definitionHash), seq = 1;
    for (const [i, size] of split(entries, periods).entries()) {
      for (const part of split(size, objectsPerPeriod)) {
        const lines = makeLines(part, seq, prev, instance, shard, sources);
        objects.push({ shard, instance, period: FIRST_PERIOD + i * PERIOD_MS, lines });
        prev = lines[lines.length - 1].hash; seq += part;
      }
    }
  }
  return objects.sort((a, b) => a.period - b.period || a.shard.localeCompare(b.shard));
}

function instanceOf(o) {
  const last = o.lines[o.lines.length - 1];
  return { collection: COLLECTION, shard: o.shard, fromSeq: o.lines[0].seq, toSeq: last.seq, headHash: last.hash, merkleRoot: merkleRoot(o.lines.map((l) => l.hash)), archiveKey: 'k' };
}

function buildDigests(objects, definitionHash) {
  const digests = [];
  let prevDigest = digestGenesisHash(ORG, STORE);
  for (const period of [...new Set(objects.map((o) => o.period))]) {
    const d = { v: 1, org: ORG, store: STORE, period: { start: new Date(period).toISOString(), end: new Date(period + PERIOD_MS).toISOString() }, prevDigestHash: prevDigest,
      ledgers: [{ name: LEDGER, definitionHash, definition: DEFINITION, instances: objects.filter((o) => o.period === period).map(instanceOf) }], signedAt: '2026-10-15T01:00:00.000Z' };
    digests.push({ period, name: label(period), digest: d });
    prevDigest = sha256Hex(bytesOf(d));
  }
  return digests;
}

export async function buildFixture({ entries, periods, shards = 1, objectsPerPeriod = 1, bindings = false, customer = false, legacyBindings = false, types, tokenBytes, sources }) {
  const dir = mkdtempSync(tmpdir() + '/kvlv-');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const definitionHash = sha256Hex(canonicalJson(DEFINITION));
  const objects = buildObjects({ entries, periods, shards, objectsPerPeriod, sources }, definitionHash);
  const digests = buildDigests(objects, definitionHash);
  const signDigest = (rec) => { rec.sig = sign('sha256', bytesOf(rec.digest), { key: privateKey, dsaEncoding: 'der' }).toString('base64'); };
  digests.forEach(signDigest);
  for (const o of objects) o.name = objName(o);

  const base = join(dir, 'ledgers', ORG, STORE, LEDGER, Buffer.from(COLLECTION).toString('base64url'));
  const objPath = (o) => join(base, o.shard, o.name);
  const digDir = join(dir, 'digests', ORG, STORE);
  const anchorsDir = join(digDir, 'anchors');
  const dayOf = (rec) => rec.name.slice(0, 8);
  const anchors = new Map(); // day -> digest index (binding mode)
  mkdirSync(anchorsDir, { recursive: true });
  for (let i = 0; i < shards; i++) mkdirSync(join(base, shardName(i)), { recursive: true });

  function flush() {
    for (const o of objects) writeFileSync(objPath(o), gzipSync(o.lines.map((l) => JSON.stringify(l) + '\n').join('')));
    const lastOfDay = new Map();
    for (const r of digests) {
      const name = r.name;
      writeFileSync(join(digDir, name + '.json'), bytesOf(r.digest));
      writeFileSync(join(digDir, name + '.json.sig'), JSON.stringify({ v: 1, keyId: 'test', algorithm: 'ECDSA_SHA_256', signature: r.sig }));
      lastOfDay.set(dayOf(r), r);
    }
    if (bindings) for (const [day, r] of lastOfDay) if (!anchors.has(day) && !removedDays.has(day)) anchors.set(day, digests.indexOf(r));
    const tokens = bindings ? new Map([...anchors].map(([day, i]) => [day, digests[i]])) : lastOfDay;
    for (const [day, r] of tokens) writeToken(day, r);
  }
  const corrupt = new Set(), removedDays = new Set(), edits = new Map();
  // The token bytes of a day: tokenBytes (a function of the imprint, or fixed bytes), else a made token.
  function tokenOf(day, hex) {
    if (typeof tokenBytes === 'function') return tokenBytes(hex);
    return tokenBytes ?? makeToken(corrupt.has(day) ? '07'.repeat(32) : hex);
  }
  function bindingOf(r, hex) {
    const typed = legacyBindings ? {} : { types: types ?? [customer ? 'customer-bucket' : 'rfc3161'] };
    return { v: 1, digestKey: `digests/${ORG}/${STORE}/${r.name}.json`, digestHash: hex, anchoredAt: '2026-10-15T00:10:00.000Z', ...typed };
  }
  function writeToken(day, r) {
    const hex = createHash('sha256').update(bytesOf(r.digest)).digest().toString('hex');
    if (!customer || types?.includes('rfc3161')) writeFileSync(join(anchorsDir, day + '.tsr'), tokenOf(day, hex));
    if (!bindings) return;
    const b = bindingOf(r, hex);
    writeFileSync(join(anchorsDir, day + '.anchor.json'), JSON.stringify(edits.has(day) ? edits.get(day)(b) : b));
  }
  flush();

  const find = (n, shard) => objects.find((o) => o.shard === shard && o.lines.some((l) => l.seq === n));
  return {
    tsaRootsPem: [TEST_ROOT_PEM], dir, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), anchorsDir,
    receipts: objects.flatMap((o) => o.lines.map((l) => ({ key: l.key, seq: l.seq, hash: l.hash, prevHash: l.prevHash }))),
    rewriteLine(n, fn, shard = '00') { const o = find(n, shard); o.lines = o.lines.map((l) => (l.seq === n ? fn(l) : l)); flush(); },
    dropLine(n) { const o = find(n, '00'); o.lines = o.lines.filter((l) => l.seq !== n); flush(); },
    rechainFrom(n) {
      let prevHash;
      for (const o of objects) for (const l of o.lines) {
        if (l.seq === n - 1) prevHash = l.hash;
        if (l.seq < n) continue;
        l.value = JSON.stringify({ type: 'plaintext', value: { n: l.seq, rewritten: true } }); l.prevHash = prevHash;
        l.hash = entryHash({ prevHash, instance: o.instance, seq: l.seq, id: l.id, at: l.at, stored: l.value }); prevHash = l.hash;
      }
      flush();
    },
    editDigest(i, fn) { digests[i].digest = fn(digests[i].digest); flush(); },
    editDigestUnsigned(i, fn) { digests[i].digest = fn(digests[i].digest); signDigest(digests[i]); flush(); },
    corruptAnchor(i) { corrupt.add(dayOf(digests[i])); flush(); },
    removeAnchor(i) { rmSync(join(anchorsDir, dayOf(digests[i]) + '.tsr')); },
    // The customer's bucket copy: <org>/<store>/ with every digest, .sig and binding as the archive has them now.
    makeCopies() {
      const root = mkdtempSync(tmpdir() + '/kvlv-copies-'), to = join(root, ORG, STORE);
      mkdirSync(join(to, 'anchors'), { recursive: true });
      for (const n of readdirSync(digDir).filter((x) => x.endsWith('.json') || x.endsWith('.sig'))) copyFileSync(join(digDir, n), join(to, n));
      for (const n of readdirSync(anchorsDir).filter((x) => x.endsWith('.anchor.json'))) copyFileSync(join(anchorsDir, n), join(to, 'anchors', n));
      return root;
    },
    removeBinding(i) { rmSync(join(anchorsDir, dayOf(digests[i]) + '.anchor.json')); },
    editBinding(i, fn) { edits.set(dayOf(digests[i]), fn); flush(); },
    // A late digest for a past period: written after the anchor, chained after the latest digest.
    addSupplementDigest() {
      const prev = digests[digests.length - 1];
      const d = { ...prev.digest, prevDigestHash: sha256Hex(bytesOf(prev.digest)), ledgers: [], signedAt: '2026-10-15T02:00:00.000Z' };
      const rec = { period: prev.period, name: `${prev.name.split('_')[0]}_000001`, digest: d };
      signDigest(rec); digests.push(rec); flush();
      return digests.length - 1;
    },
    anchorDigest(i) { anchors.set(dayOf(digests[i]), i); flush(); },
    removeSig(i) { rmSync(join(digDir, digests[i].name + '.json.sig')); },
    removeDigest(i) { for (const ext of ['.json', '.json.sig']) rmSync(join(digDir, digests[i].name + ext)); },
    removeObject(i) { rmSync(objPath(objects[i])); },
    corruptObject(i) { writeFileSync(objPath(objects[i]), Buffer.from('not gzip')); },
    garbleLine(i) { writeFileSync(objPath(objects[i]), gzipSync('not json\n' + objects[i].lines.slice(1).map((l) => JSON.stringify(l) + '\n').join(''))); },
    // Deletes the newest digest and its objects but keeps the day's timestamp token.
    truncateLastPeriod() {
      const last = digests[digests.length - 1];
      rmSync(join(digDir, last.name + '.json')); rmSync(join(digDir, last.name + '.json.sig'));
      for (const o of objects.filter((x) => x.period === last.period)) rmSync(objPath(o));
    },
  };
}
