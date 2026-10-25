// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// purge-check: binds a signed archive purge receipt and its manifest pages (the lists of deleted objects) to the handoff copy of the archive.
// A problem is one line that names a file or a page and the check; it never holds file content.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { sha256Hex } from './hash.mjs';
import { PURGE_RECEIPT_TYPE, verifySigned } from './signed.mjs';

const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const baseName = (key) => key.slice(key.lastIndexOf('/') + 1);

// The lines of one page: { lines } or { badInput: true } when the bytes are not gzip JSONL of objects.
function pageLines(bytes) {
  let text;
  try { text = gunzipSync(bytes).toString('utf8'); } catch { return { badInput: true }; }
  const out = [];
  for (const l of text.split('\n').filter((x) => x.length > 0)) {
    let v;
    try { v = JSON.parse(l); } catch { return { badInput: true }; }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { badInput: true };
    out.push(v);
  }
  return { lines: out };
}

// One page against its manifest entry: a missing page and a hash mismatch are problems and the page is not parsed.
function checkPage(entry, given) {
  const name = baseName(entry.key);
  if (!given) return { problems: [`page ${name}: not given`], lines: [] };
  if (sha256Hex(given.bytes) !== entry.sha256) return { problems: [`page ${name}: sha256 differs from the receipt`], lines: [] };
  const parsed = pageLines(given.bytes);
  if (parsed.badInput) return { problems: [], lines: [], badInput: true };
  const miscount = parsed.lines.length === entry.count ? [] : [`page ${name}: ${parsed.lines.length} lines, receipt says ${entry.count}`];
  return { problems: miscount, lines: parsed.lines };
}

function extraPages(manifest, pages) {
  const names = new Set(manifest.map((m) => baseName(m.key)));
  const seen = new Set();
  const out = [];
  for (const p of pages) {
    if (seen.has(p.name)) out.push(`page ${p.name}: given more than once`);
    else if (!names.has(p.name)) out.push(`page ${p.name}: not in the receipt`);
    seen.add(p.name);
  }
  return out;
}

function checkPages(objects, pages) {
  const byName = new Map(pages.map((p) => [p.name, p]));
  const results = objects.manifest.map((m) => checkPage(m, byName.get(baseName(m.key))));
  const problems = [...results.flatMap((r) => r.problems), ...extraPages(objects.manifest, pages)];
  const total = objects.manifest.reduce((n, m) => n + m.count, 0);
  if (total !== objects.count) problems.push(`page counts: the pages add up to ${total} lines, objects.count is ${objects.count}`);
  return { problems, lines: results.flatMap((r) => r.lines), badInput: results.some((r) => r.badInput) };
}

// Every entry under ledgers/<org>/<store>/ and digests/<org>/<store>/ (key: path from the root, with /):
// { files } are regular files, { odd } are entries that are neither a file nor a folder (a symlink, for example).
function entriesUnder(root, prefix) {
  const dir = join(root, prefix);
  const out = { files: [], odd: [] };
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const key = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      const sub = entriesUnder(root, key);
      out.files.push(...sub.files); out.odd.push(...sub.odd);
    } else (e.isFile() ? out.files : out.odd).push(key);
  }
  return out;
}

function checkHandoff(handoffDir, receipt, lines) {
  const keyHashes = new Set(lines.map((l) => l.keySha256));
  const pairs = new Set(lines.map((l) => `${l.keySha256} ${l.sha256}`));
  const found = [`ledgers/${receipt.org}/${receipt.store}`, `digests/${receipt.org}/${receipt.store}`].map((prefix) => entriesUnder(handoffDir, prefix));
  const keys = found.flatMap((f) => f.files).sort(byteOrder);
  const problems = found.flatMap((f) => f.odd).sort(byteOrder).map((key) => `handoff ${key}: not a regular file`);
  for (const key of keys) {
    const kh = sha256Hex(key);
    if (!keyHashes.has(kh)) problems.push(`handoff ${key}: not in the manifest`);
    else if (!pairs.has(`${kh} ${sha256Hex(readFileSync(join(handoffDir, key)))}`)) problems.push(`handoff ${key}: content sha256 not in the manifest`);
  }
  return { problems, files: keys.length };
}

// The newest digest: the last *.json by byte order of name, directly in digests/<org>/<store>/.
function checkNewestDigest(handoffDir, receipt) {
  const dir = join(handoffDir, 'digests', receipt.org, receipt.store);
  const names = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort(byteOrder) : [];
  if (names.length === 0) return [`handoff has no digest for ${receipt.org}/${receipt.store}`];
  const newest = names[names.length - 1];
  return sha256Hex(readFileSync(join(dir, newest))) === receipt.chain.lastDigestHash ? [] : [`newest digest ${newest}: sha256 differs from chain.lastDigestHash`];
}

const refused = (problems, extra = {}) => ({ ok: false, badInput: false, problems, summary: { handoffFiles: 0, pages: 0, lines: 0 }, ...extra });

export function purgeCheck({ handoffDir, receiptDoc, pages, keys }) {
  const signed = verifySigned(receiptDoc, keys);
  if (!signed.ok) return refused([`signature invalid: ${signed.reason}`]);
  const receipt = signed.signed;
  if (receipt.type !== PURGE_RECEIPT_TYPE) return refused(['not an archive purge receipt']);
  const pg = checkPages(receipt.objects, pages);
  const handoff = checkHandoff(handoffDir, receipt, pg.lines);
  const problems = [...pg.problems, ...handoff.problems, ...checkNewestDigest(handoffDir, receipt)];
  return { ok: problems.length === 0 && !pg.badInput, badInput: pg.badInput, problems, receipt,
    summary: { handoffFiles: handoff.files, pages: receipt.objects.manifest.length, lines: pg.lines.length } };
}
