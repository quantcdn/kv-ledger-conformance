// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Step 5 of verify-proof: the daily anchor that covers the proof's digest.
// The binding <day>.anchor.json names one exact digest (digestKey, digestHash). It covers the proof's digest when it names
// that digest, or a later one that the digest chain links back to it (each digest holds the SHA-256 of the one before).
// Evidence, for each type the binding lists:
//   rfc3161          <day>.tsr: a full RFC 3161 check (CMS signature, DigiCert chain to the pinned root) and imprint = digestHash;
//   customer-bucket  the copy in the customer's bucket: the binding copy is byte-identical and the bound digest copy hashes to digestHash.
// The binding passes when no listed type fails and at least one type has evidence (a binding alone is not external evidence).
import { X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from './hash.mjs';
import { tokenImprintHex, verifyTimestampToken } from './tsr.mjs';

const DAY = /^\d{8}$/;
const DIGEST_NAME = /^\d{8}T\d{4}Z(_\d{6})?$/;
const HASH = /^[0-9a-f]{64}$/;
const TYPES = ['customer-bucket', 'rfc3161'];
const readIf = (file) => (existsSync(file) ? readFileSync(file) : undefined);
const parse = (buf) => { try { return JSON.parse(buf.toString('utf8')); } catch { return undefined; } };
const nameOf = (key, prefix) => key.slice(prefix.length, -'.json'.length);
// The copy root is the customer prefix (<org>/<store>/ inside) or that store folder itself.
const storeDirOf = (base, org, store) => (existsSync(join(base, org, store)) ? join(base, org, store) : base);

function context(proof, digestBytes, opts) {
  const { org, store } = proof.digest;
  const copies = opts.anchorCopiesDir ? storeDirOf(opts.anchorCopiesDir, org, store) : undefined;
  const anchors = opts.anchorDir ?? join(copies, 'anchors');
  return { prefix: `digests/${org}/${store}/`, digestKey: proof.digestKey, digestBytes, anchors, copies, digestDir: opts.anchorDir ? dirname(opts.anchorDir) : copies,
    fromCopy: !opts.anchorDir, roots: opts.tsaRootsPem?.map((p) => new X509Certificate(p)), day: DAY.test(proof.anchor?.day ?? '') ? proof.anchor.day : undefined };
}

const validTypes = (t) => Array.isArray(t) && t.length > 0 && t.every((x, i) => TYPES.includes(x) && (i === 0 || t[i - 1] < x));
function bindingOk(b, prefix) {
  const key = b?.digestKey;
  return b?.v === 1 && validTypes(b.types) && typeof key === 'string' && key.startsWith(prefix) && key.endsWith('.json')
    && DIGEST_NAME.test(nameOf(key, prefix)) && HASH.test(String(b.digestHash));
}

// The earliest binding (day order) whose bound digest is the proof's digest or a later one, as the proof route chooses it.
function coveringDay(ctx) {
  const days = existsSync(ctx.anchors) ? readdirSync(ctx.anchors).filter((n) => /^\d{8}\.anchor\.json$/.test(n)).sort() : [];
  const cover = days.find((n) => {
    const key = parse(readFileSync(join(ctx.anchors, n)))?.digestKey;
    return typeof key === 'string' && key >= ctx.digestKey;
  });
  return cover?.slice(0, 8);
}

function findBinding(ctx) {
  const day = ctx.day ?? coveringDay(ctx);
  if (!day) return { fault: `no anchor binding in ${ctx.anchors} covers ${ctx.digestKey}` };
  const bytes = readIf(join(ctx.anchors, `${day}.anchor.json`));
  if (!bytes) return { fault: `binding_missing: ${day}.anchor.json is not in ${ctx.anchors}` };
  const b = parse(bytes);
  if (!bindingOk(b, ctx.prefix)) return { fault: `bad_binding: ${day}.anchor.json is malformed` };
  if (b.digestKey < ctx.digestKey) return { fault: `the binding of ${day} names an earlier digest (${b.digestKey}); it does not cover this digest` };
  return { day, bytes, b, bound: nameOf(b.digestKey, ctx.prefix) };
}

// The digests after the proof's digest, up to the bound one, in name (chain) order.
function laterDigests(ctx, found) {
  const own = nameOf(ctx.digestKey, ctx.prefix);
  const names = existsSync(ctx.digestDir) ? readdirSync(ctx.digestDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : [];
  return names.filter((n) => DIGEST_NAME.test(n) && n > own && n <= found.bound).sort();
}

// Undefined when the binding's digestHash is reached from the proof's digest; else the reason.
function chainFault(ctx, found) {
  if (found.b.digestKey === ctx.digestKey) {
    return sha256Hex(ctx.digestBytes) === found.b.digestHash ? undefined : 'digest_hash_differs: the binding digestHash is not SHA-256 of the proof digest';
  }
  const names = laterDigests(ctx, found);
  let prev = sha256Hex(ctx.digestBytes);
  for (const n of names) {
    const bytes = readFileSync(join(ctx.digestDir, `${n}.json`));
    if (parse(bytes)?.prevDigestHash !== prev) return `digest chain: ${n}.json does not link to the digest before it`;
    prev = sha256Hex(bytes);
  }
  if (names[names.length - 1] !== found.bound) return `digest chain: the bound digest ${found.bound}.json is not in ${ctx.digestDir}`;
  ctx.chainLength = names.length;
  return prev === found.b.digestHash ? undefined : `digest chain: digest_hash_differs (${found.bound}.json does not hash to the binding digestHash)`;
}

function tokenEvidence(ctx, found) {
  const tsr = readIf(join(ctx.anchors, `${found.day}.tsr`));
  if (!tsr) return { fail: `binding_without_token: ${found.day}.tsr is not in ${ctx.anchors}` };
  try { verifyTimestampToken(tsr, ctx.roots ? { roots: ctx.roots } : {}); } catch (e) { return { fail: `bad_token_signature: ${e.message}` }; }
  if (tokenImprintHex(tsr) !== found.b.digestHash) return { fail: 'token_imprint_differs: the token imprint is not the binding digestHash' };
  return { ok: `rfc3161 token verified (${ctx.roots ? 'the given --tsa-root' : 'pinned DigiCert Trusted Root G4'}, imprint = digestHash)` };
}

function copyEvidence(ctx, found) {
  if (!ctx.copies) return { unwitnessed: 'customer-bucket not checked: customer_copy_not_provided (pass --anchor-copies)' };
  const copy = readIf(join(ctx.copies, 'anchors', `${found.day}.anchor.json`));
  if (!copy) return { fail: `binding_copy_missing: anchors/${found.day}.anchor.json is not in the customer copy` };
  if (!copy.equals(found.bytes)) return { fail: 'binding_copy_differs: the customer copy of the binding is not byte-identical' };
  const digest = readIf(join(ctx.copies, `${found.bound}.json`));
  if (!digest || sha256Hex(digest) !== found.b.digestHash) return { fail: `copy_missing_digest: the customer copy has no ${found.bound}.json with the bound hash` };
  return { ok: ctx.fromCopy ? 'customer copy holds the binding and the bound digest' : 'customer copy matches (binding and bound digest)' };
}

const EVIDENCE = { rfc3161: tokenEvidence, 'customer-bucket': copyEvidence };

function verdict(ctx, found, results) {
  const n = ctx.chainLength ?? 0;
  const head = `binding ${found.day} → ${found.bound}.json${n ? ` (${n} later digest${n === 1 ? '' : 's'}, chain links)` : ''}`;
  const fails = results.filter((r) => r.fail).map((r) => r.fail);
  if (fails.length) return { ok: false, detail: `${head}: ${fails.join('; ')}` };
  const ok = results.filter((r) => r.ok).map((r) => r.ok), notes = results.filter((r) => r.unwitnessed).map((r) => r.unwitnessed);
  if (!ok.length) return { ok: false, detail: `${head}: no external evidence: ${notes.join('; ')}` };
  return { ok: true, detail: `${head}: ${[...ok, ...notes].join('; ')}` };
}

/** Step 5 with anchor files. opts: { anchorDir?, anchorCopiesDir?, tsaRootsPem? }. Returns { ok, detail }. */
export function checkProofAnchor(proof, digestBytes, opts) {
  const ctx = context(proof, digestBytes, opts);
  const found = findBinding(ctx);
  if (found.fault) return { ok: false, detail: found.fault };
  const chain = chainFault(ctx, found);
  if (chain) return { ok: false, detail: `binding ${found.day}: ${chain}` };
  return verdict(ctx, found, found.b.types.map((t) => EVIDENCE[t](ctx, found)));
}
