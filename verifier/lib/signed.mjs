// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Signed documents: a verification report or a shred receipt is { json, signature, keyId, algorithm?, report? | receipt? }.
// json is the RFC 8785 (JCS) text that was signed; signature is base64 DER ECDSA P-256 over the SHA-256 of its UTF-8
// bytes (KMS ECDSA_SHA_256, the ledger key, the same scheme as the digest .sig files). Only json is trusted: when the
// document also carries report or receipt (the parsed form), it must be exactly json.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './jcs.mjs';

export const SIGNED_ALGORITHM = 'ECDSA_SHA_256';
// The document types this verifier knows, each with its verdict from the signed json.
// A verification report is INTACT only when it is complete and ok; a failure found is FAILED, also in an incomplete
// report; any other incomplete report is INCOMPLETE (it covers part of its scope only).
const reportVerdict = (r) => {
  if (Number(r.shardsFailed) > 0 || (r.complete === true && r.ok !== true)) return 'FAILED';
  return r.complete === true && r.ok === true ? 'INTACT' : 'INCOMPLETE';
};
// A shred receipt is RECORDED when the erasure has its shred entries on the ledger record. FORKED-NOT-RECORDED: the shred
// was made on a forked store, so the key is destroyed but no shred entry was recorded (a re-shred after the fork is
// resolved has its own receipt). NOT-RECORDED: no shred entry for another reason (a DROPPED ledger takes no entries).
const receiptVerdict = (r) => {
  if (r.ledgerForked === true) return 'FORKED-NOT-RECORDED';
  return r.entryCount > 0 ? 'RECORDED' : 'NOT-RECORDED';
};
// What each receipt verdict means: a signed statement by Quant, not a proof of the entries.
export const RECEIPT_MEANING = {
  RECORDED: 'Quant signed that this erasure\'s shred entries are on the ledger record; prove each entry with the proof route or verify.',
  'FORKED-NOT-RECORDED': 'Quant signed that the subject key was destroyed on a forked store and no shred entry was recorded; a later receipt that supersedes this one records them.',
  'NOT-RECORDED': 'Quant signed that the subject key was destroyed and no shred entry could be appended (a DROPPED ledger).',
  PURGED: 'Quant signed that it deleted every archive object of this deleted store that is listed in the manifest, and that both store prefixes held no object version and no delete marker at checkedAt. It is Quant\'s signed statement, not a proof that no copy exists: the copies named in residual remain until their dates. Run purge-check to bind it to your handoff copy.',
};
/** SHA-256 of the JCS of the entries ({ key, shard, seq, hash }, sorted by key), as the receipt's entriesSha256. */
export const entriesSha256 = (entries) => createHash('sha256').update(canonicalJson(entries)).digest('hex');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/, HEX64 = /^[0-9a-f]{64}$/;
const text = (v) => typeof v === 'string' && v.length > 0;
const isEntry = (e) => !!e && text(e.key) && /^\d{2}$/.test(e.shard) && Number.isSafeInteger(e.seq) && e.seq >= 1 && text(e.hash)
  && Object.keys(e).length === 4;
const RECEIPT_FIELDS = new Set(['v', 'type', 'id', 'org', 'store', 'ledger', 'subjectRef', 'shreddedAt', 'fullyErasedAfter', 'reason', 'authority',
  'requestedBy', 'entryCount', 'entriesSha256', 'entries', 'ledgerForked', 'supersedes', 'refKeyVersion', 'backfilled', 'keyReissued']);
const RECEIPT_CHECKS = [
  [(r) => r.v === 1 || r.v === 2, 'v is not 1 or 2'],
  [(r) => Object.keys(r).every((k) => RECEIPT_FIELDS.has(k)), 'an unknown receipt field'],
  [(r) => ULID.test(r.id) && (r.supersedes === undefined || ULID.test(r.supersedes)), 'id or supersedes is not a shred id'],
  [(r) => [r.org, r.store, r.ledger, r.reason, r.authority, r.requestedBy].every(text), 'a missing org, store, ledger, reason, authority or requestedBy'],
  [(r) => /^[0-9a-f]{32}$/.test(r.subjectRef), 'subjectRef is not 32 hex characters'],
  [(r) => ISO.test(r.shreddedAt) && ISO.test(r.fullyErasedAfter), 'shreddedAt or fullyErasedAfter is not an ISO time'],
  [(r) => Number.isSafeInteger(r.entryCount) && r.entryCount >= 0 && HEX64.test(r.entriesSha256), 'entryCount or entriesSha256 is malformed'],
  [(r) => r.ledgerForked === undefined || (r.ledgerForked === true && r.entryCount === 0), 'ledgerForked with shred entries'],
  [(r) => r.v === 2 || r.refKeyVersion === undefined, 'refKeyVersion in a v1 receipt'],
  [(r) => r.v !== 2 || (Number.isSafeInteger(r.refKeyVersion) && r.refKeyVersion >= 1), 'refKeyVersion is not a positive integer'],
  [(r) => r.v !== 2 || (r.backfilled === undefined && r.keyReissued === undefined), 'backfilled or keyReissued in a v2 receipt'],
  [(r) => [r.backfilled, r.keyReissued].every((f) => f === undefined || f === true) && (r.keyReissued === undefined || r.backfilled === true), 'backfilled or keyReissued is malformed'],
  [(r) => r.entries === undefined || (Array.isArray(r.entries) && r.entries.every(isEntry)), 'a malformed shred entry'],
  [(r) => r.entries === undefined || (r.entries.length === r.entryCount && entriesSha256(r.entries) === r.entriesSha256), 'entries do not match entryCount and entriesSha256'],
];
const receiptFault = (r) => { const f = RECEIPT_CHECKS.find(([ok]) => !ok(r)); return f ? `malformed receipt: ${f[1]}` : undefined; };

// An archive purge receipt: Quant's signed statement that it deleted the archive objects of a deleted store.
export const PURGE_RECEIPT_TYPE = 'kv-ledger-archive-purge-receipt';
const purgeVerdict = () => 'PURGED';
// Receipt times are ISO-8601 UTC with Z, with or without milliseconds.
const ISO_T = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const PURGE_FIELDS = new Set(['v', 'type', 'purgeId', 'org', 'store', 'scope', 'requestedBy', 'requestedAt', 'reason', 'completedAt', 'storeRecord',
  'chain', 'objects', 'emptiness', 'subjectKeyRowsDeleted', 'residual', 'keyId', 'signedAt']);
const RESIDUAL_KINDS = new Set(['dynamodb-pitr-system-backup', 'subject-key-pitr', 'registry-pitr', 'kv-export-files', 'customer-bucket-anchor-copies']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const isManifestEntry = (m) => isObj(m) && text(m.key) && text(m.versionId) && HEX64.test(m.sha256) && count(m.count);
const isResidual = (x) => isObj(x) && RESIDUAL_KINDS.has(x.kind)
  && (x.kind === 'customer-bucket-anchor-copies' ? text(x.bucketArn) : ISO_T.test(x.until));
// lockMode is the ledger's lockMode as declared ('governance' | 'compliance'). The platform signs it in lowercase
// (spec: storeRecord.ledgers[].lockMode = ledger lockMode); upper case is accepted too.
const LOCK_MODES = new Set(['governance', 'compliance', 'GOVERNANCE', 'COMPLIANCE']);
const isLedgerRec = (l) => isObj(l) && text(l.name) && text(l.definitionHash) && LOCK_MODES.has(l.lockMode) && Number.isSafeInteger(l.retentionDays);
const manifestOk = (o) => Array.isArray(o.manifest) && o.manifest.every(isManifestEntry) && o.manifestSha256 === entriesSha256(o.manifest);
const PURGE_CHECKS = [
  [(r) => r.v === 1, 'v is not 1'],
  [(r) => Object.keys(r).every((k) => PURGE_FIELDS.has(k)), 'an unknown receipt field'],
  [(r) => ULID.test(r.purgeId), 'purgeId is not a purge id'],
  [(r) => [r.org, r.store, r.keyId].every(text), 'a missing org, store or keyId'],
  [(r) => r.scope === 'store', 'scope is not store'],
  [(r) => /^(user|token):[0-9]{1,20}$/.test(r.requestedBy), 'requestedBy is not user:<id> or token:<id>'],
  [(r) => r.reason === undefined || (text(r.reason) && r.reason.length <= 500), 'reason is not 1-500 characters'],
  [(r) => [r.requestedAt, r.completedAt, r.signedAt].every((t) => ISO_T.test(t)), 'requestedAt, completedAt or signedAt is not an ISO time'],
  [(r) => isObj(r.storeRecord) && ISO_T.test(r.storeRecord.deletedAt) && Array.isArray(r.storeRecord.ledgers) && r.storeRecord.ledgers.every(isLedgerRec), 'storeRecord is malformed'],
  [(r) => isObj(r.chain) && HEX64.test(r.chain.lastDigestHash) && text(r.chain.lastDigest) && text(r.chain.firstDigest), 'chain.lastDigestHash, lastDigest or firstDigest is malformed'],
  [(r) => isObj(r.chain) && [r.chain.digestCount, r.chain.anchorDays].every(count), 'chain.digestCount or anchorDays is malformed'],
  [(r) => isObj(r.objects) && ['count', 'bytes', 'ledgerObjects', 'digestObjects', 'anchorObjects'].every((k) => count(r.objects[k])), 'an objects count is malformed'],
  [(r) => isObj(r.objects) && manifestOk(r.objects), 'objects.manifest or objects.manifestSha256 is malformed'],
  [(r) => isObj(r.emptiness) && r.emptiness.versions === 0 && r.emptiness.deleteMarkers === 0, 'emptiness.versions or deleteMarkers is not 0'],
  [(r) => isObj(r.emptiness) && ISO_T.test(r.emptiness.checkedAt), 'emptiness.checkedAt is not an ISO time'],
  [(r) => isObj(r.emptiness) && Array.isArray(r.emptiness.prefixes) && r.emptiness.prefixes.join('|') === `ledgers/${r.org}/${r.store}/|digests/${r.org}/${r.store}/`, 'emptiness.prefixes are not the two store prefixes'],
  [(r) => count(r.subjectKeyRowsDeleted), 'subjectKeyRowsDeleted is malformed'],
  [(r) => Array.isArray(r.residual) && r.residual.every(isResidual), 'a malformed residual entry'],
];
export const purgeReceiptFault = (r) => { const f = PURGE_CHECKS.find(([ok]) => !ok(r)); return f ? `malformed purge receipt: ${f[1]}` : undefined; };
const SHAPES = { 'kv-ledger-shred-receipt': receiptFault, [PURGE_RECEIPT_TYPE]: purgeReceiptFault };
export const DOCUMENT_TYPES = { 'kv-ledger-verification-report': reportVerdict, 'kv-ledger-shred-receipt': receiptVerdict, [PURGE_RECEIPT_TYPE]: purgeVerdict };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const fail = (reason) => ({ ok: false, reason });

// keys: one PEM (used whatever keyId says), or an object that maps keyId to PEM.
function keyFor(doc, keys) {
  if (typeof keys === 'string') return keys;
  return keys && typeof keys === 'object' && Object.prototype.hasOwnProperty.call(keys, doc.keyId) ? keys[doc.keyId] : undefined;
}
function p256(pem) {
  const key = createPublicKey(pem);
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : undefined;
}
function shapeFault(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'the document is not a JSON object';
  if (typeof doc.json !== 'string' || typeof doc.signature !== 'string' || !BASE64.test(doc.signature)) return 'the document needs json and a base64 signature';
  if (doc.algorithm !== undefined && doc.algorithm !== SIGNED_ALGORITHM) return `algorithm ${doc.algorithm} is not ${SIGNED_ALGORITHM}`;
  return undefined;
}
function parsedCanonical(json) {
  try {
    const value = JSON.parse(json);
    return canonicalJson(value) === json ? { value } : undefined;
  } catch { return undefined; }
}
// The reason a copy of the signed json (doc.report or doc.receipt) differs from it, or undefined.
function copyFault(doc, field) {
  return doc[field] !== undefined && canonicalJson(doc[field]) !== doc.json ? `${field} differs from the signed json` : undefined;
}

function contentFault(doc, parsed) {
  if (!parsed) return 'json is not in canonical (JCS) form';
  const type = parsed.value?.type;
  if (!Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, type)) return `unknown document type ${type}`;
  return copyFault(doc, 'report') || SHAPES[type]?.(parsed.value) || copyFault(doc, 'receipt');
}

// → { ok: true, signed, verdict } with the parsed signed json and its verdict (a report: INTACT, FAILED or INCOMPLETE;
// a shred receipt: RECORDED, FORKED-NOT-RECORDED or NOT-RECORDED), or
// { ok: false, reason } when the signature or the document is not valid.
export function verifySigned(doc, keys) {
  const shape = shapeFault(doc);
  if (shape) return fail(shape);
  const pem = keyFor(doc, keys);
  if (!pem) return fail(`no public key for keyId ${doc.keyId}`);
  const key = p256(pem);
  if (!key) return fail('the public key is not an ECDSA P-256 key');
  const sig = Buffer.from(doc.signature, 'base64');
  if (!verify('sha256', Buffer.from(doc.json, 'utf8'), { key, dsaEncoding: 'der' }, sig)) return fail('bad signature');
  const parsed = parsedCanonical(doc.json), content = contentFault(doc, parsed);
  return content ? fail(content) : { ok: true, signed: parsed.value, verdict: DOCUMENT_TYPES[parsed.value.type](parsed.value) };
}

// --public-keys <file>: a JSON object { keyId: pem }, the public-key route answer { keyId, publicKeyPem }, or an array of those.
export function keysFromJson(text) {
  const v = JSON.parse(text);
  const list = Array.isArray(v) ? v : [v];
  if (list.every((k) => k && typeof k.keyId === 'string' && typeof k.publicKeyPem === 'string')) return Object.fromEntries(list.map((k) => [k.keyId, k.publicKeyPem]));
  if (!Array.isArray(v) && v && typeof v === 'object' && Object.values(v).every((p) => typeof p === 'string')) return v;
  throw new Error('--public-keys must map keyId to PEM, or hold { keyId, publicKeyPem } entries');
}
