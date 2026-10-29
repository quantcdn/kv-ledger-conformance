// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// One saved inclusion proof (GET .../ledgers/{name}/proof?key=), checked with no archive and no Quant service:
//   1. the entry hash recomputes from the entry fields (byte layout qkv-ledger-v1);
//   2. the audit path folds from that hash, at leafIndex in a tree of treeSize leaves, to merkleRoot (RFC 9162);
//   3. the signed digest lists the proof's archive object with that root, for that collection, shard and position;
//   4. the digest signature (ECDSA P-256, SHA-256 over the JCS bytes of the digest) verifies with the public key;
//   5. with anchor files: the daily anchor that covers the digest (RFC 3161 token and/or the customer-bucket copy).
// A pending proof ({ status: 'pending' }) is not yet verifiable: it fails, never passes.
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './jcs.mjs';
import { keyNamed, publicKeyId } from './key-id.mjs';
import { entryHash, instanceName, sha256Hex } from './hash.mjs';
import { rootFromAuditPath } from './merkle.mjs';
import { checkProofAnchor } from './proof-anchor.mjs';

const HASH = /^[0-9a-f]{64}$/;
const isInt = (n, min) => Number.isSafeInteger(n) && n >= min;
const text = (v) => typeof v === 'string' && v.length > 0;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGEST_NAME = /^\d{8}T\d{4}Z(_\d{6})?$/;
const short = (h) => (typeof h === 'string' ? `${h.slice(0, 12)}…` : String(h));

const PROOF_FIELDS = [
  ['entry', (p) => isObject(p.entry)], ['hash', (p) => HASH.test(p.hash)], ['archiveKey', (p) => text(p.archiveKey)],
  ['merkleRoot', (p) => HASH.test(p.merkleRoot)], ['auditPath', (p) => Array.isArray(p.auditPath)], ['leafIndex', (p) => Number.isSafeInteger(p.leafIndex)],
  ['treeSize', (p) => Number.isSafeInteger(p.treeSize)], ['digest', (p) => isObject(p.digest) && text(p.digest.org) && text(p.digest.store)],
  ['digestKey', (p) => text(p.digestKey)], ['signature', (p) => text(p.signature) && BASE64.test(p.signature)],
];

// Step 0: only an archived proof with every field can be checked.
function statusFault(proof) {
  if (!isObject(proof)) return 'the proof is not a JSON object';
  if (proof.status === 'pending') {
    return 'pending: not yet verifiable (the entry is not archived, or its digest is not signed yet); fetch the proof again later';
  }
  if (proof.status !== 'archived') return `status ${JSON.stringify(proof.status)} is not "archived"`;
  const missing = PROOF_FIELDS.filter(([, ok]) => !ok(proof)).map(([name]) => name);
  return missing.length ? `malformed proof: missing or invalid ${missing.join(', ')}` : undefined;
}

// Input rules of the entry hash: integers in range, no newline in a field that is joined with newlines.
const placeOk = (e) => text(e.collection) && !e.collection.includes('\n') && text(e.shard) && (e.key === undefined || e.key === `${e.collection}:${e.id}`);
const entryWellFormed = (e) => isObject(e) && isInt(e.seq, 1) && isInt(e.at, 0) && text(e.id) && !e.id.includes('\n')
  && typeof e.value === 'string' && HASH.test(e.prevHash) && placeOk(e);

// Step 1. `held` is the record the auditor holds (--entry); without it, the entry inside the proof is checked.
function checkEntry(proof, held) {
  const e = held ?? proof.entry;
  if (!entryWellFormed(e)) return { ok: false, detail: 'the entry is malformed (needs collection, shard, id, seq >= 1, at >= 0, value, prevHash; no newline in id or collection; key, when present, = collection:id)' };
  const instance = instanceName(proof.digest.org, proof.digest.store, e.collection, e.shard);
  const recomputed = entryHash({ prevHash: e.prevHash, instance, seq: e.seq, id: e.id, at: e.at, stored: e.value });
  const stated = [e.hash, proof.entry.hash].filter((h) => h !== undefined);
  const ok = recomputed === proof.hash && stated.every((h) => h === proof.hash);
  const what = held ? 'the given entry' : 'the proof entry';
  return { ok, entry: e, detail: ok ? `${what} recomputes to ${recomputed} = proof hash` : `${what} recomputes to ${recomputed}, which differs from the proof hash ${proof.hash}` };
}

// Step 2.
function checkPath(proof) {
  const root = rootFromAuditPath(proof.hash, proof.leafIndex, proof.treeSize, proof.auditPath);
  const where = `leaf ${proof.leafIndex} of ${proof.treeSize}, ${proof.auditPath.length} path hashes`;
  if (!root) return { ok: false, detail: `the audit path does not fold to a root (${where})` };
  const ok = root === proof.merkleRoot;
  return { ok, root, detail: ok ? `the audit path folds to merkleRoot ${root} (${where})` : `the audit path folds to ${root}, not to merkleRoot ${proof.merkleRoot} (${where})` };
}

const ledgersOf = (d) => (Array.isArray(d.ledgers) ? d.ledgers : []);
function instanceFor(digest, archiveKey) {
  for (const l of ledgersOf(digest)) {
    const inst = (Array.isArray(l?.instances) ? l.instances : []).find((i) => i?.archiveKey === archiveKey);
    if (inst) return { ledger: l, inst };
  }
  return undefined;
}
function definitionOk(ledger) {
  try { return sha256Hex(canonicalJson(ledger.definition)) === ledger.definitionHash; } catch { return false; }
}
function digestKeyOk(proof) {
  const prefix = `digests/${proof.digest.org}/${proof.digest.store}/`, key = proof.digestKey;
  return key.startsWith(prefix) && key.endsWith('.json') && DIGEST_NAME.test(key.slice(prefix.length, -'.json'.length));
}
const DIGEST_CHECKS = [
  [(c) => digestKeyOk(c.proof), 'the digestKey is not a digest of this store (digests/<org>/<store>/<period>[_n].json)'],
  [(c) => !!c.found, 'the digest does not list the proof archiveKey'],
  [(c) => c.found.inst.merkleRoot === c.root, 'the digest instance merkleRoot differs from the folded root'],
  [(c) => !c.entry || (c.found.inst.collection === c.entry.collection && c.found.inst.shard === c.entry.shard), 'the digest instance is for another collection or shard'],
  [(c) => !c.entry || c.proof.leafIndex === c.entry.seq - c.found.inst.fromSeq, 'leafIndex is not entry seq - fromSeq of the digest instance'],
  [(c) => c.proof.treeSize === c.found.inst.toSeq - c.found.inst.fromSeq + 1, 'treeSize is not the size of the digest instance'],
  [(c) => definitionOk(c.found.ledger), 'the ledger definitionHash is not SHA-256 of the JCS of its definition'],
];

// Step 3. The digest must list this archive object with the root of step 2, for this entry's place.
function checkDigest(proof, s1, s2) {
  const c = { proof, found: instanceFor(proof.digest, proof.archiveKey), root: s2.root, entry: s1.entry };
  const fault = DIGEST_CHECKS.find(([ok]) => !ok(c));
  if (fault) return { ok: false, detail: fault[1] };
  return { ok: true, detail: `${proof.digestKey} lists ${proof.archiveKey.split('/').pop()} (seq ${c.found.inst.fromSeq}-${c.found.inst.toSeq}) with merkleRoot ${short(c.root)}` };
}

// keys: one PEM (used whatever keyId says), or an object that maps keyId to PEM (a key ARN and its key id match).
function keyFor(proof, keys) {
  if (typeof keys === 'string') return { pem: keys };
  const pem = isObject(keys) ? keyNamed(keys, proof.keyId) : undefined;
  return pem === undefined ? { fault: `no public key for keyId ${shownKeyId(proof.keyId)}` } : { pem };
}
// A step line names the public key id, never an account id from an old key ARN.
const shownKeyId = (keyId) => (typeof keyId === 'string' ? publicKeyId(keyId) : keyId);
function p256(pem) {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : undefined;
  } catch { return undefined; }
}
function signatureValid(key, bytes, signature) {
  try { return verify('sha256', bytes, { key, dsaEncoding: 'der' }, Buffer.from(signature, 'base64')); } catch { return false; }
}

// Step 4.
function checkSignature(proof, keys) {
  const k = keyFor(proof, keys);
  if (k.fault) return { ok: false, detail: k.fault };
  const key = p256(k.pem);
  if (!key) return { ok: false, detail: 'the public key is not an ECDSA P-256 key' };
  const ok = signatureValid(key, Buffer.from(canonicalJson(proof.digest), 'utf8'), proof.signature);
  const by = typeof keys === 'string' ? `the given key; the proof keyId ${shownKeyId(proof.keyId)} is not checked against it` : `keyId ${shownKeyId(proof.keyId)}`;
  return { ok, detail: ok ? `the ECDSA P-256 signature over the JCS bytes of the digest verifies (${by})` : `the signature does not verify over the JCS bytes of the digest (${by})` };
}

// Step 5 without anchor files: a note, never a failure.
function anchorNote(proof) {
  if (proof.anchorUnavailable === true) return 'not checked: the proof says the anchor lookup failed (anchorUnavailable); download the anchor files and run with --anchor-dir';
  if (!proof.anchor) return 'no anchor covers this digest yet (or the store has no anchor); nothing to check';
  return `not checked: anchor ${proof.anchor.day} (${proof.anchor.type}); pass --anchor-dir (and --anchor-copies for a customer-bucket anchor)`;
}
function checkAnchorStep(proof, opts) {
  if (!opts.anchorDir && !opts.anchorCopiesDir) return { ok: true, note: true, detail: anchorNote(proof) };
  return checkProofAnchor(proof, Buffer.from(canonicalJson(proof.digest), 'utf8'), opts);
}

const STEP_NAMES = { 0: 'status', 1: 'entry hash', 2: 'audit path', 3: 'digest', 4: 'signature', 5: 'anchor' };
const step = (n, r) => ({ step: n, name: STEP_NAMES[n], ok: r.ok, ...(r.note ? { note: true } : {}), detail: r.detail });

/**
 * verifyProof({ proof, keys, entry?, anchorDir?, anchorCopiesDir?, tsaRootsPem? }) →
 * { ok, status, badInput?, entry?: { key, collection, shard, seq }, digestKey?, steps: [{ step, name, ok, note?, detail }] }.
 * badInput: the proof is malformed or has an unknown status (the CLI exits 2); a pending proof is a failure (exit 1).
 * keys: one PEM, or { keyId: pem }. ok is true only when every step passes (a note is not a failure).
 */
export function verifyProof({ proof, keys, entry, anchorDir, anchorCopiesDir, tsaRootsPem }) {
  const fault = statusFault(proof);
  const status = isObject(proof) ? proof.status : undefined;
  if (fault) return { ok: false, status, badInput: status !== 'pending', steps: [step(0, { ok: false, detail: fault })] };
  const s1 = checkEntry(proof, entry), s2 = checkPath(proof), s3 = checkDigest(proof, s1, s2), s4 = checkSignature(proof, keys);
  const s5 = checkAnchorStep(proof, { anchorDir, anchorCopiesDir, tsaRootsPem });
  const steps = [s1, s2, s3, s4, s5].map((r, i) => step(i + 1, r));
  const e = s1.entry ?? proof.entry;
  return { ok: steps.every((s) => s.ok), status, entry: { key: e.key, collection: e.collection, shard: e.shard, seq: e.seq }, digestKey: proof.digestKey, steps };
}
