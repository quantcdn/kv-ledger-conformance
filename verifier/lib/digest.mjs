// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Digest files: signatures, the digest chain, definition hashes and timestamp tokens.
import { createPublicKey, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './jcs.mjs';
import { digestGenesisHash, sha256Hex } from './hash.mjs';
import { tokenImprintHex, verifyTimestampToken } from './tsr.mjs';

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

function signatureOk(key, bytes, sigFile) {
  if (!existsSync(sigFile)) return false;
  const sig = parseJson(readFileSync(sigFile));
  if (!sig || sig.v !== 1 || sig.algorithm !== 'ECDSA_SHA_256' || typeof sig.signature !== 'string') return false;
  try {
    return verify('sha256', bytes, { key, dsaEncoding: 'der' }, Buffer.from(sig.signature, 'base64'));
  } catch { return false; }
}

function definitionsOk(digest) {
  const ledgers = Array.isArray(digest?.ledgers) ? digest.ledgers : [];
  try {
    return ledgers.every((l) => sha256Hex(canonicalJson(l.definition)) === l.definitionHash);
  } catch { return false; }
}

const isP256 = (key) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';

const readSig = (file) => (existsSync(file) ? readFileSync(file) : undefined);

function readStore(root, org, store, key) {
  const dir = join(root, org, store);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  let prev = digestGenesisHash(org, store);
  for (const name of names) {
    const bytes = readFileSync(join(dir, name));
    const digest = parseJson(bytes);
    const sigOk = isP256(key) && signatureOk(key, bytes, join(dir, name + '.sig'));
    const chainOk = digest?.prevDigestHash === prev;
    out.push({ org, store, period: name.slice(0, -'.json'.length), bytes, sigBytes: readSig(join(dir, name + '.sig')), digest: digest ?? {}, sigOk, chainOk, defOk: definitionsOk(digest) });
    prev = sha256Hex(bytes);
  }
  return out;
}

// Returns the digest records of one store in period order.
export function readDigests(dir, publicKeyPem, org, store) {
  return readStore(join(dir, 'digests'), org, store, createPublicKey(publicKeyPem));
}

export const digestTrusted = (d) => d.sigOk && d.chainOk && d.defOk;

function lastPerDay(records) {
  const days = new Map();
  for (const r of records) days.set(`${r.org}/${r.store}/${r.period.slice(0, 8)}`, r);
  return days;
}

const listDir = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)).sort() : []);

// The token directory is <anchors>/<org>/<store> when it exists, else <anchors> itself (flat).
const tokenDir = (anchorsDir, org, store) => (existsSync(join(anchorsDir, org, store)) ? join(anchorsDir, org, store) : anchorsDir);

const NAME = /^\d{8}T\d{4}Z(_\d{6})?$/;
const HASH = /^[0-9a-f]{64}$/;

// A binding names the exact digest an anchor covers: { v: 1, digestKey, digestHash, anchoredAt }.
// The digest name of a well-formed binding, or undefined.
function bindingName(b, prefix) {
  const keyOk = b && b.v === 1 && typeof b.digestKey === 'string' && b.digestKey.startsWith(prefix) && b.digestKey.endsWith('.json');
  if (!keyOk) return undefined;
  const name = b.digestKey.slice(prefix.length, -'.json'.length);
  return NAME.test(name) && typeof b.digestHash === 'string' && HASH.test(b.digestHash) ? name : undefined;
}

// The reason the digest record of a binding cannot be used, or undefined.
function recordFault(rec, digestHash) {
  if (!rec) return 'digest_not_in_chain';
  if (sha256Hex(rec.bytes) !== digestHash) return 'digest_hash_differs';
  return digestTrusted(rec) ? undefined : 'digest_not_trusted';
}

function readBinding(file, org, store, byName) {
  const b = parseJson(readFileSync(file));
  const name = bindingName(b, `digests/${org}/${store}/`);
  if (name === undefined) return { error: 'bad_binding' };
  const rec = byName.get(name);
  const fault = recordFault(rec, b.digestHash);
  if (fault) return { error: fault };
  const types = parseTypes(b);
  if (types === null) return { error: 'bad_binding' };
  return { name, digestHash: b.digestHash, rec, types };
}

const TYPES = ['customer-bucket', 'rfc3161'];
// `types`: sorted, unique, non-empty, known. undefined = a legacy binding without the field; null = invalid.
function parseTypes(b) {
  if (!('types' in b)) return undefined;
  const t = b.types;
  const valid = Array.isArray(t) && t.length > 0 && t.every((x) => TYPES.includes(x)) && t.every((x, i) => i === 0 || t[i - 1] < x);
  return valid ? t : null;
}

// Returns undefined when the token is good, else the failure reason. Every token must pass the full
// CMS signature and pinned-chain check; a token that is not a valid RFC 3161 response fails, even when
// it carries the right imprint bytes.
function checkToken(file, hashHex, roots) {
  const tsr = readFileSync(file);
  try { verifyTimestampToken(tsr, roots ? { roots } : {}); } catch { return 'bad_token_signature'; }
  return tokenImprintHex(tsr) === hashHex ? undefined : 'token_imprint_differs';
}

// Customer-bucket copies: every copied digest, .sig and binding must be byte-identical to the archive,
// and the bound digest must be present with its .sig. Copies start at the first anchored digest,
// so the digests from the earliest copy up to the bound digest must all be present.
function checkCopies(ctx, b, day, copies) {
  const { copiesDir } = ctx;
  const fail = (d, reason) => { ctx.fail(d, reason); return false; };
  const local = readSig(join(ctx.dir, day + '.anchor.json'));
  const copy = readSig(join(copiesDir, 'anchors', day + '.anchor.json'));
  if (!copy) return fail(day, 'binding_copy_missing');
  if (!local.equals(copy)) return fail(day, 'binding_copy_differs');
  const upTo = ctx.digests.filter((d) => d.index <= b.rec.index && d.period >= copies.first);
  const bad = upTo.find((d) => !copies.names.has(d.period) || !copies.sigs.has(d.period));
  if (bad || !copies.names.has(b.name)) return fail(day, 'copy_missing_digest');
  return true;
}

// Reads the copy directory once; reports copies that differ from, or are absent in, the archive.
function readCopies(ctx) {
  const byName = new Map(ctx.digests.map((d) => [d.period, d]));
  const names = new Map(), sigs = new Map();
  let ok = true;
  for (const f of listDir(ctx.copiesDir, /^\d{8}T\d{4}Z(_\d{6})?\.json(\.sig)?$/)) {
    const isSig = f.endsWith('.sig');
    const name = f.slice(0, f.length - (isSig ? '.json.sig'.length : '.json'.length));
    const rec = byName.get(name);
    const mine = isSig ? rec?.sigBytes : rec?.bytes;
    const theirs = readFileSync(join(ctx.copiesDir, f));
    if (!mine) { ctx.fail(name, 'copy_not_in_archive'); ok = false; } else if (!mine.equals(theirs)) { ctx.fail(name, 'copy_differs'); ok = false; }
    (isSig ? sigs : names).set(name, true);
  }
  const first = [...names.keys()].sort()[0] ?? '';
  return { ok, names, sigs, first };
}

// Evidence for one binding type: 'ok', 'unwitnessed' (nothing to check it against) or 'fail'.
function evidence(type, ctx, b, day) {
  if (type === 'rfc3161') {
    const tsr = join(ctx.dir, day + '.tsr');
    if (!existsSync(tsr)) { ctx.fail(day, 'binding_without_token'); return 'fail'; }
    ctx.result.checked += 1;
    const reason = checkToken(tsr, b.digestHash, ctx.roots);
    if (reason) { ctx.fail(day, reason); return 'fail'; }
    return 'ok';
  }
  if (!ctx.copies) {
    (ctx.result.unwitnessed ??= []).push({ day, type, reason: 'customer_copy_not_provided' });
    return 'unwitnessed';
  }
  if (!checkCopies(ctx, b, day, ctx.copies)) return 'fail';
  ctx.result.checked += 1;
  return 'ok';
}

// A binding alone is not external evidence. It covers its digest only when no listed type fails and
// at least one type has evidence. A legacy binding without `types` is typed by its token file.
function checkBinding(ctx, f) {
  const day = f.slice(0, 8);
  const b = readBinding(join(ctx.dir, f), ctx.org, ctx.store, ctx.byName);
  ctx.result.bindings += 1;
  if (b.error) { ctx.fail(day, b.error); return -1; }
  const types = b.types ?? (existsSync(join(ctx.dir, day + '.tsr')) ? ['rfc3161'] : ['customer-bucket']);
  const results = types.map((t) => evidence(t, ctx, b, day));
  if (results.includes('fail') || !results.includes('ok')) return -1;
  ctx.result.boundDigests.push({ day, digestKey: `digests/${ctx.org}/${ctx.store}/${b.name}.json` });
  return b.rec.index;
}

function checkBindings(digests, dir, org, store, files, copiesDir, roots) {
  const result = { mode: 'bindings', checked: 0, bindings: 0, boundDigests: [], mismatched: [] };
  const byName = new Map(digests.map((d, i) => [d.period, Object.assign(d, { index: i })]));
  const fail = (day, reason) => {
    result.mismatched.push(`${org}/${store}/${day}`);
    (result.details ??= []).push({ day, reason });
  };
  const ctx = { fail, dir, digests, copiesDir, org, store, byName, result, roots };
  ctx.copies = copiesDir ? readCopies(ctx) : undefined;
  const covered = Math.max(-1, ...files.bindings.map((f) => checkBinding(ctx, f)));
  const bound = new Set(files.bindings.map((f) => f.slice(0, 8)));
  for (const t of files.tokens) if (!bound.has(t.slice(0, 8))) fail(t.slice(0, 8), 'token_without_binding');
  const tail = digests.slice(covered + 1).map((d) => `${org}/${store}/${d.period.slice(0, 8)}`);
  if (tail.length) result.unanchoredDays = [...new Set(tail)];
  if (result.checked > 0) result.tokenCheck = 'signature';
  return result;
}

// Legacy layout (no binding files): the token covers the last digest of its UTC day.
function checkLegacy(digests, dir, org, store, files, roots) {
  const result = { mode: 'legacy', checked: 0, mismatched: [] };
  const unanchored = [];
  const days = lastPerDay(digests);
  for (const [name, r] of days) {
    const file = join(dir, r.period.slice(0, 8) + '.tsr');
    if (!existsSync(file)) { unanchored.push(name); continue; }
    result.checked += 1;
    const reason = checkToken(file, sha256Hex(r.bytes), roots);
    if (reason) { result.mismatched.push(name); (result.details ??= []).push({ day: name.slice(-8), reason }); }
  }
  for (const t of files.tokens) {
    if (!days.has(`${org}/${store}/${t.slice(0, 8)}`)) result.mismatched.push(`${org}/${store}/${t.slice(0, 8)}`);
  }
  if (unanchored.length) result.unanchoredDays = unanchored;
  if (result.checked > 0) result.tokenCheck = 'signature';
  return result;
}

// Anchors of ONE store. With binding files, each token must match its binding (imprint == digestHash)
// and every digest up to the latest bound digest is covered through the digest chain; digests after
// it are `unanchoredDays` and fail the check. Without binding files the legacy rule applies and the
// result says `mode: 'legacy'`. The imprint check is not a CMS check: use `openssl ts -verify`.
export function checkAnchors(digests, anchorsDir, org, store, copiesBase, roots) {
  const dir = tokenDir(anchorsDir, org, store);
  const files = { bindings: listDir(dir, /^\d{8}\.anchor\.json$/), tokens: listDir(dir, /^\d{8}\.tsr$/) };
  return files.bindings.length ? checkBindings(digests, dir, org, store, files, copiesBase && tokenDir(copiesBase, org, store), roots) : checkLegacy(digests, dir, org, store, files, roots);
}
