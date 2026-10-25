// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// checkProof(proof, publicKeyPem): the four checks of an archived inclusion proof (spec 7; ledgers page
// "Inclusion Proof" and "Byte Layout (Version 1)"):
//   1. the entry hash recomputes from `entry` (instance from digest.org, digest.store, entry.collection, entry.shard)
//      and equals `hash`;
//   2. `auditPath` from `hash` at `leafIndex` in `treeSize` leaves folds to `merkleRoot` (RFC 9162);
//   3. the digest lists the proof's `archiveKey` with that root, for the entry's collection and shard, with
//      leafIndex = seq - fromSeq and treeSize = toSeq - fromSeq + 1 (and a digestKey of the store, and a
//      definitionHash that is the SHA-256 of the JCS of its definition);
//   4. `signature` (base64 DER ECDSA P-256) verifies over the SHA-256 of the JCS bytes of `digest`.
// Step 0 refuses a pending or malformed proof before the four steps. Independent code; it accepts what the offline
// verifier (verifier/lib/proof.mjs) accepts for steps 1 to 4.
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson, entryHash, instanceName, rootFromAuditPath, sha256Hex } from './ledger-bytes.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGEST_FILE = /^\d{8}T\d{4}Z(_\d{6})?\.json$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const filled = (v) => typeof v === 'string' && v !== '';
const safeInt = (v, min = -Infinity) => Number.isSafeInteger(v) && v >= min;
const noNewline = (v) => filled(v) && !v.includes('\n');

// [field, well-formed(proof)] for step 0.
const REQUIRED = [
  ['entry', (p) => isObj(p.entry)],
  ['hash', (p) => HEX64.test(p.hash)],
  ['archiveKey', (p) => filled(p.archiveKey)],
  ['merkleRoot', (p) => HEX64.test(p.merkleRoot)],
  ['auditPath', (p) => Array.isArray(p.auditPath)],
  ['leafIndex', (p) => safeInt(p.leafIndex)],
  ['treeSize', (p) => safeInt(p.treeSize)],
  ['digest', (p) => isObj(p.digest) && filled(p.digest.org) && filled(p.digest.store)],
  ['digestKey', (p) => filled(p.digestKey)],
  ['signature', (p) => filled(p.signature) && B64.test(p.signature)],
];

function statusProblem(proof) {
  if (!isObj(proof)) return 'the proof is not an object';
  if (proof.status !== 'archived') return `status ${JSON.stringify(proof.status)}: only an archived proof can be checked`;
  const bad = REQUIRED.filter(([, ok]) => !ok(proof)).map(([field]) => field);
  return bad.length === 0 ? null : `missing or invalid: ${bad.join(', ')}`;
}

const keyFits = (e) => e.key === undefined || e.key === `${e.collection}:${e.id}`;
const entryOk = (e) => safeInt(e.seq, 1) && safeInt(e.at, 0) && noNewline(e.id) && noNewline(e.collection)
  && filled(e.shard) && typeof e.value === 'string' && HEX64.test(e.prevHash) && keyFits(e);

function stepEntry(proof) {
  const e = proof.entry;
  if (!entryOk(e)) return { ok: false, detail: 'the entry is malformed' };
  const instance = instanceName(proof.digest.org, proof.digest.store, e.collection, e.shard);
  const hash = entryHash({ prevHash: e.prevHash, instance, seq: e.seq, id: e.id, at: e.at, stored: e.value });
  const ok = hash === proof.hash && (e.hash === undefined || e.hash === proof.hash);
  return { ok, entry: e, detail: ok ? `the entry recomputes to ${hash}` : `the entry recomputes to ${hash}, not ${proof.hash}` };
}

function stepPath(proof) {
  const root = rootFromAuditPath(proof.hash, proof.leafIndex, proof.treeSize, proof.auditPath);
  if (root === undefined) return { ok: false, detail: 'the audit path does not fit the leaf index and tree size' };
  const ok = root === proof.merkleRoot;
  return { ok, root, detail: ok ? `the audit path folds to ${root}` : `the audit path folds to ${root}, not ${proof.merkleRoot}` };
}

function findInstance(digest, archiveKey) {
  for (const ledger of Array.isArray(digest.ledgers) ? digest.ledgers : []) {
    const list = Array.isArray(ledger?.instances) ? ledger.instances : [];
    const inst = list.find((i) => i?.archiveKey === archiveKey);
    if (inst !== undefined) return { ledger, inst };
  }
  return null;
}

function definitionMatches(ledger) {
  try {
    return sha256Hex(Buffer.from(canonicalJson(ledger.definition), 'utf8')) === ledger.definitionHash;
  } catch {
    return false;
  }
}

function digestKeyOfStore(proof) {
  const prefix = `digests/${proof.digest.org}/${proof.digest.store}/`;
  return proof.digestKey.startsWith(prefix) && DIGEST_FILE.test(proof.digestKey.slice(prefix.length));
}

const samePlace = (c) => c.entry === undefined
  || (c.found.inst.collection === c.entry.collection && c.found.inst.shard === c.entry.shard);
const samePosition = (c) => c.entry === undefined || c.proof.leafIndex === c.entry.seq - c.found.inst.fromSeq;

// [holds(c), problem] for step 3, in order.
const DIGEST_RULES = [
  [(c) => digestKeyOfStore(c.proof), 'the digestKey is not a digest of the store'],
  [(c) => c.found !== null, 'the digest does not list the archiveKey'],
  [(c) => c.found.inst.merkleRoot === c.root, 'the digest instance has another merkleRoot'],
  [samePlace, 'the digest instance is for another collection or shard'],
  [samePosition, 'leafIndex is not seq - fromSeq'],
  [(c) => c.proof.treeSize === c.found.inst.toSeq - c.found.inst.fromSeq + 1, 'treeSize is not toSeq - fromSeq + 1'],
  [(c) => definitionMatches(c.found.ledger), 'the definitionHash does not match the definition'],
];

function stepDigest(proof, entry, root) {
  const c = { proof, entry, root, found: findInstance(proof.digest, proof.archiveKey) };
  const broken = DIGEST_RULES.find(([holds]) => !holds(c));
  return broken ? { ok: false, detail: broken[1] } : { ok: true, detail: `the digest lists ${proof.archiveKey}` };
}

function p256Key(pem) {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

function stepSignature(proof, publicKeyPem) {
  const key = p256Key(publicKeyPem);
  if (key === null) return { ok: false, detail: 'the public key is not an ECDSA P-256 key' };
  let ok = false;
  try {
    const bytes = Buffer.from(canonicalJson(proof.digest), 'utf8');
    ok = verify('sha256', bytes, { key, dsaEncoding: 'der' }, Buffer.from(proof.signature, 'base64'));
  } catch {
    ok = false;
  }
  return { ok, detail: ok ? 'the signature verifies over the JCS bytes of the digest' : 'the signature does not verify' };
}

const row = (step, r) => ({ step, ok: r.ok, detail: r.detail });

/** { ok, steps: [{ step, ok, detail }] }: steps 1 to 4, or step 0 alone for a pending or malformed proof. */
export function checkProof(proof, publicKeyPem) {
  const problem = statusProblem(proof);
  if (problem !== null) return { ok: false, steps: [row(0, { ok: false, detail: problem })] };
  const s1 = stepEntry(proof);
  const s2 = stepPath(proof);
  const steps = [s1, s2, stepDigest(proof, s1.entry, s2.root), stepSignature(proof, publicKeyPem)]
    .map((r, i) => row(i + 1, r));
  return { ok: steps.every((s) => s.ok), steps };
}
