#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// kv-ledger-verify verify-signed --doc <file.json> (--public-key <key.pem> | --public-keys <keys.json>)
// kv-ledger-verify purge-check <handoffDir> <receipt.json> <manifest-*.jsonl.gz...> (--public-key <key.pem> | --public-keys <keys.json>)
// kv-ledger-verify verify-proof <proof.json> (--public-key <key.pem> | --public-keys <keys.json>) [--entry <entry.json>] [--anchor-dir <dir>] [--anchor-copies <dir>] [--tsa-root <pem>] [--json]
// kv-ledger-verify --dir <archive root> --store <org>/<store> --public-key <key.pem> [--receipts <file.jsonl>] [--anchors <dir>] [--anchor-copies <dir>] [--tsa-root <pem>] [--as-of <ISO time>] [--strict] [--json]
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { verifyArchive } from './lib/verify.mjs';
import { entriesSha256, keysFromJson, PURGE_RECEIPT_TYPE, RECEIPT_MEANING, verifySigned } from './lib/signed.mjs';
import { verifyProof } from './lib/proof.mjs';
import { publicKeyId } from './lib/key-id.mjs';
import { purgeCheck } from './lib/purge.mjs';

const USAGE = 'usage: verify.mjs --dir <archive root> --store <org>/<store> --public-key <key.pem> [--receipts <receipts.jsonl>] [--anchors <dir>] [--anchor-copies <dir>] [--tsa-root <pem>] [--as-of <ISO time>] [--strict] [--list-entries] [--json]';
const VALUE_FLAGS = { '--dir': 'dir', '--store': 'store', '--public-key': 'publicKey', '--receipts': 'receipts', '--anchors': 'anchors', '--anchor-copies': 'anchorCopies', '--tsa-root': 'tsaRoot', '--as-of': 'asOf' };

const BOOL_FLAGS = { '--json': 'json', '--strict': 'strict', '--list-entries': 'listEntries' };
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) opts[BOOL_FLAGS[a]] = true;
    else if (VALUE_FLAGS[a] && argv[i + 1] !== undefined) opts[VALUE_FLAGS[a]] = argv[++i];
    else throw new Error(`unknown or incomplete option ${a}`);
  }
  if (opts.asOf !== undefined) opts.asOf = parseAsOf(opts.asOf);
  if (!opts.dir || !opts.publicKey || !opts.store) throw new Error('--dir, --store and --public-key are required');
  return opts;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
function parseAsOf(v) {
  const ms = ISO.test(v) ? Date.parse(v) : NaN;
  // Date.parse rolls some bad dates over (2026-02-30): the date and time fields must survive the round trip.
  const [y, mo, d, h, mi] = v.match(/\d+/g).map(Number);
  const u = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const real = u.getUTCFullYear() === y && u.getUTCMonth() === mo - 1 && u.getUTCDate() === d && u.getUTCHours() === h && u.getUTCMinutes() === mi;
  if (Number.isNaN(ms) || !real) throw new Error(`--as-of must be an ISO 8601 time with a zone, for example 2026-10-16T03:30:00Z (got ${v})`);
  return ms;
}

function readReceipts(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Provenance: entries per writer, then (--list-entries) each entry with its writer.
const writer = (s, none) => (s ? `${s.type} ${s.principal}` : none);
function sourceLines(r) {
  const out = r.sources?.length ? ['sources (entries whose hash verifies):'] : [];
  for (const s of r.sources ?? []) out.push(`  ${String(s.entries).padStart(8)}  ${writer(s.source, '(none: before provenance)')}`);
  for (const e of r.entryList ?? []) out.push(`  entry ${e.collection}#${e.shard} seq ${e.seq} ${e.key} ${e.hash} ${writer(e.source, '-')}`);
  return out;
}

function summaryHead(r) {
  const verdict = !r.ok ? 'FAILED' : r.pending?.length ? 'INCOMPLETE' : 'OK';
  return `${verdict} ${r.store}: ${r.entries} entries in ${r.shards.length} shard(s)`;
}
function shardLine(s) {
  const where = `${s.collection}#${s.shard} seq ${s.fromSeq}-${s.toSeq}`;
  return s.ok ? `  ok      ${where}` : `  BROKEN  ${where}: ${s.reason} at seq ${s.firstBrokenSeq}`;
}
function pendingLines(pending) {
  if (!pending?.length) return [];
  return [`INCOMPLETE: ${pending.length} objects pending (digest not written yet)`,
    ...pending.map((p) => `  ${p.collection}#${p.shard} seq ${p.fromSeq}-${p.toSeq}`)];
}
// The lines of a receipts or anchors check, when the result has one.
function checkLines(k, c) {
  if (!c) return [];
  const lines = [];
  if (c.details?.length) lines.push(...c.details.map((d) => `  anchor ${d.day}: ${d.reason}`));
  if (c.unwitnessed?.length) lines.push(...c.unwitnessed.map((d) => `  anchor ${d.day}: no external evidence (${d.reason})`));
  if (c.unanchoredDays?.length) lines.push(`anchors: no token for ${c.unanchoredDays.join(', ')}`);
  const list = c.mismatched.length ? ' (' + c.mismatched.join(', ') + ')' : '';
  lines.push(`${k}: ${c.checked} checked, ${c.mismatched.length} mismatched${list}`);
  return lines;
}

function summary(r) {
  const lines = [summaryHead(r)];
  if (r.reason) lines.push(`  archive for ${r.store} not found in the archive root (${r.reason})`);
  lines.push(...r.shards.map(shardLine), ...sourceLines(r), ...pendingLines(r.pending));
  for (const k of ['receipts', 'anchors']) lines.push(...checkLines(k, r[k]));
  return lines.join('\n');
}

// verify-signed: a signed verification report (GET .../verifications/{id}/report) or a shred receipt (the receipt of a
// shred answer, or GET .../shreds/{shredId}/receipt). 'signature valid', then the verdict of the signed json: a report is
// INTACT (exit 0), FAILED (exit 1) or INCOMPLETE (exit 3); a receipt is RECORDED (exit 0), FORKED-NOT-RECORDED or
// NOT-RECORDED (exit 3). Then the signed json (the only part to trust). Bad input is exit 2; 'signature invalid: <reason>' is exit 4.
const SIGNED_USAGE = 'usage: verify.mjs verify-signed --doc <file.json> (--public-key <key.pem> | --public-keys <keys.json>) [--entries <entries.json>]';
const VERDICT_EXIT = { INTACT: 0, FAILED: 1, INCOMPLETE: 3, RECORDED: 0, 'FORKED-NOT-RECORDED': 3, 'NOT-RECORDED': 3, PURGED: 0 };
const SUMMARY = {
  'kv-ledger-verification-report': (v) => `complete ${v.complete}, ok ${v.ok}, ${v.entries} entries, ${v.shardsFailed} shards failed`,
  'kv-ledger-shred-receipt': (v) => `subjectRef ${v.subjectRef}, shreddedAt ${v.shreddedAt}, fullyErasedAfter ${v.fullyErasedAfter}, ${v.entryCount} shred entries`
    + `${v.entries ? '' : ' (not listed: check them with --entries)'}${v.ledgerForked ? ', ledger forked' : ''}${v.supersedes ? `, supersedes ${v.supersedes}` : ''}`
    + `${v.keyReissued ? ', backfilled: key re-issued, shreddedAt is the earliest shred entry' : v.backfilled ? ', backfilled' : ''}`,
};
SUMMARY[PURGE_RECEIPT_TYPE] = (v) => `${v.objects.count} objects, ${v.objects.bytes} bytes, completedAt ${v.completedAt}, last digest ${v.chain.lastDigest}`;
// The second output line starts with the verdict and the type, then the id of the document and what it covers.
const heading = (v) => (v.type === PURGE_RECEIPT_TYPE ? `${v.purgeId} ${v.org}/${v.store}` : `${v.id ?? ''} ${v.org}/${v.store} ledger ${v.ledger}`);
const SIGNED_FLAGS = { '--doc': 'doc', '--public-key': 'publicKey', '--public-keys': 'publicKeys', '--entries': 'entries' };
function parseSignedArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!SIGNED_FLAGS[argv[i]] || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    opts[SIGNED_FLAGS[argv[i]]] = argv[++i];
  }
  if (!opts.doc || (!opts.publicKey === !opts.publicKeys)) throw new Error('--doc and one of --public-key or --public-keys are required');
  return opts;
}
// --entries: the shred entries of a receipt that left them out (above 300 KB): a JSON array, or the answers of
// GET .../shreds/{shredId}/entries (one, or an array of pages). They must hash to the receipt's entriesSha256.
function entriesFrom(text) {
  const v = JSON.parse(text);
  const isPage = (p) => !!p && !Array.isArray(p) && Array.isArray(p.entries);
  if (isPage(v)) return v.entries;
  if (!Array.isArray(v)) throw new Error('--entries must be a JSON array of entries or of entries pages');
  return v.length > 0 && v.every(isPage) ? v.flatMap((p) => p.entries) : v;
}
function entriesFault(signed, entries) {
  if (!entries) return undefined;
  if (signed.type !== 'kv-ledger-shred-receipt') return '--entries is for a shred receipt';
  return entries.length === signed.entryCount && entriesSha256(entries) === signed.entriesSha256 ? undefined : 'the entries do not match entryCount and entriesSha256';
}
function verifySignedCommand(argv) {
  let doc, keys, entries;
  try {
    const opts = parseSignedArgs(argv);
    doc = JSON.parse(readFileSync(opts.doc, 'utf8'));
    keys = opts.publicKey ? readFileSync(opts.publicKey, 'utf8') : keysFromJson(readFileSync(opts.publicKeys, 'utf8'));
    entries = opts.entries ? entriesFrom(readFileSync(opts.entries, 'utf8')) : undefined;
  } catch (e) { console.error(`${e.message}\n${SIGNED_USAGE}`); return 2; }
  let r;
  try { r = verifySigned(doc, keys); } catch (e) { console.error(`cannot read input: ${e.message}`); return 2; }
  if (!r.ok) { console.log(`signature invalid: ${r.reason}`); return 4; }
  const v = r.signed, badEntries = entriesFault(v, entries);
  if (badEntries) { console.log(`signature invalid: ${badEntries}`); return 4; }
  console.log(`signature valid (signed by ${typeof doc.keyId === 'string' ? publicKeyId(doc.keyId) : 'the given key'})`);
  console.log(`${r.verdict} ${v.type} ${heading(v)}: ${SUMMARY[v.type](v)}`);
  if (RECEIPT_MEANING[r.verdict]) console.log(RECEIPT_MEANING[r.verdict] + (entries ? ' The given entries match the receipt.' : ''));
  console.log(JSON.stringify(v, null, 2));
  return VERDICT_EXIT[r.verdict];
}

// What an OK purge-check means: the signed statement, bound to the handoff copy by hashes.
const PURGE_CHECK_MEANING = 'Quant signed that it deleted every file of the archive in your handoff copy, and that both store prefixes held no object version and no delete marker when it checked. This holds when your handoff copy passes verify. It is Quant\'s signed statement, not a proof that no copy exists: the copies named in residual remain until their dates.';
// purge-check: binds a purge receipt (GET .../purges/{purgeId}/receipt) and its manifest pages to the handoff copy of the
// archive (the download taken before the store was deleted). OK (exit 0), NOT CONFIRMED with one line per problem (exit 1),
// bad input (exit 2). A bad receipt signature is exit 1 here.
const PURGE_USAGE = 'usage: verify.mjs purge-check <handoffDir> <receipt.json> <manifest-*.jsonl.gz...> (--public-key <key.pem> | --public-keys <keys.json>)';
const PURGE_FLAGS = { '--public-key': 'publicKey', '--public-keys': 'publicKeys' };
function parsePurgeArgs(argv) {
  const opts = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (!PURGE_FLAGS[argv[i]] || argv[i + 1] === undefined || opts[PURGE_FLAGS[argv[i]]] !== undefined) throw new Error(`unknown, repeated or incomplete option ${argv[i]}`);
      opts[PURGE_FLAGS[argv[i]]] = argv[++i];
    } else opts.files.push(argv[i]);
  }
  if (opts.files.length < 3 || (!opts.publicKey === !opts.publicKeys)) throw new Error('<handoffDir>, <receipt.json>, at least one manifest page and one of --public-key or --public-keys are required');
  return opts;
}
function purgeInput(opts) {
  const [handoffDir, receiptFile, ...pageFiles] = opts.files;
  if (!statSync(handoffDir).isDirectory()) throw new Error(`${handoffDir} is not a folder`);
  return {
    handoffDir,
    receiptDoc: JSON.parse(readFileSync(receiptFile, 'utf8')),
    pages: pageFiles.map((f) => ({ name: basename(f), bytes: readFileSync(f) })),
    keys: opts.publicKey ? readFileSync(opts.publicKey, 'utf8') : keysFromJson(readFileSync(opts.publicKeys, 'utf8')),
  };
}
function purgeCheckCommand(argv) {
  let input;
  try { input = purgeInput(parsePurgeArgs(argv)); } catch (e) { console.error(`${e.message}\n${PURGE_USAGE}`); return 2; }
  let r;
  try { r = purgeCheck(input); } catch (e) { console.error(`cannot read input: ${e.message}`); return 2; }
  if (r.badInput) { console.error('a manifest page matches the receipt but is not gzip JSON lines of objects'); return 2; }
  if (!r.ok) {
    for (const p of r.problems) console.log(p);
    console.log(`NOT CONFIRMED: ${r.problems.length} problem(s)`);
    return 1;
  }
  const v = r.receipt;
  console.log(`OK purge ${v.purgeId} ${v.org}/${v.store}: ${r.summary.handoffFiles} handoff files in the manifest, ${r.summary.pages} pages, ${r.summary.lines} lines, newest digest matches`);
  console.log(PURGE_CHECK_MEANING);
  return 0;
}

// verify-proof: one saved inclusion proof (GET .../ledgers/{name}/proof?key=), with no archive. PASS or FAIL per step,
// then VERIFIED (exit 0) or NOT VERIFIED (exit 1). A pending proof is NOT VERIFIED (exit 1). Bad input, also a malformed proof, is exit 2.
const PROOF_USAGE = 'usage: verify.mjs verify-proof <proof.json> (--public-key <key.pem> | --public-keys <keys.json>) [--entry <entry.json>] [--anchor-dir <dir>] [--anchor-copies <dir>] [--tsa-root <pem>] [--json]';
const PROOF_FLAGS = { '--public-key': 'publicKey', '--public-keys': 'publicKeys', '--entry': 'entry', '--anchor-dir': 'anchorDir', '--anchor-copies': 'anchorCopies', '--tsa-root': 'tsaRoot' };
// A value flag that is known, has a value and is not repeated.
const proofValueFlag = (argv, i, opts) => PROOF_FLAGS[argv[i]] && argv[i + 1] !== undefined && opts[PROOF_FLAGS[argv[i]]] === undefined;
function parseProofArgs(argv) {
  const opts = { proof: argv[0]?.startsWith('--') ? undefined : argv[0] };
  for (let i = opts.proof === undefined ? 0 : 1; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (proofValueFlag(argv, i, opts)) opts[PROOF_FLAGS[argv[i]]] = argv[++i];
    else throw new Error(`unknown, repeated or incomplete option ${argv[i]}`);
  }
  if (!opts.proof || (!opts.publicKey === !opts.publicKeys)) throw new Error('<proof.json> and one of --public-key or --public-keys are required');
  return opts;
}
function proofInput(opts) {
  const read = (f) => readFileSync(f, 'utf8');
  return {
    proof: JSON.parse(read(opts.proof)),
    keys: opts.publicKey ? read(opts.publicKey) : keysFromJson(read(opts.publicKeys)),
    entry: opts.entry ? JSON.parse(read(opts.entry)) : undefined,
    anchorDir: opts.anchorDir, anchorCopiesDir: opts.anchorCopies,
    tsaRootsPem: opts.tsaRoot ? [read(opts.tsaRoot)] : undefined,
  };
}
function proofSummary(r) {
  const e = r.entry ? `entry ${r.entry.key ?? r.entry.collection} seq ${r.entry.seq}` : 'proof';
  const lines = [`verify-proof ${e}${r.digestKey ? ` in ${r.digestKey}` : ''}`];
  for (const s of r.steps) lines.push(`  ${s.note ? 'NOTE' : s.ok ? 'PASS' : 'FAIL'}  ${s.step} ${s.name}: ${s.detail}`);
  const failures = r.steps.filter((s) => !s.ok).length;
  lines.push(r.ok ? 'VERIFIED: the entry is in the signed digest' : `NOT VERIFIED: ${failures} step(s) failed`);
  return lines.join('\n');
}
function verifyProofCommand(argv) {
  let input, opts;
  try { opts = parseProofArgs(argv); input = proofInput(opts); } catch (e) { console.error(`${e.message}\n${PROOF_USAGE}`); return 2; }
  let r;
  try { r = verifyProof(input); } catch (e) { console.error(`cannot read input: ${e.message}`); return 2; }
  console.log(opts.json ? JSON.stringify(r, null, 2) : proofSummary(r));
  if (r.badInput) return 2;
  return r.ok ? 0 : 1;
}

const COMMANDS = new Map([['verify-signed', verifySignedCommand], ['purge-check', purgeCheckCommand], ['verify-proof', verifyProofCommand]]);
async function main() {
  const command = COMMANDS.get(process.argv[2]);
  if (command) return command(process.argv.slice(3));
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  try {
    const r = await verifyArchive({
      dir: opts.dir,
      store: opts.store,
      publicKeyPem: readFileSync(opts.publicKey, 'utf8'),
      receipts: opts.receipts ? readReceipts(opts.receipts) : undefined,
      anchorsDir: opts.anchors,
      anchorCopiesDir: opts.anchorCopies,
      tsaRootsPem: opts.tsaRoot ? [readFileSync(opts.tsaRoot, 'utf8')] : undefined,
      asOf: opts.asOf,
      strict: opts.strict,
      listEntries: opts.listEntries,
    });
    console.log(opts.json ? JSON.stringify(r, null, 2) : summary(r));
    if (!r.ok) return 1;
    return r.pending.length ? 3 : 0; // 0 pass, 1 fail, 2 usage, 3 incomplete (pending objects)
  } catch (e) { console.error(`cannot read input: ${e.message}`); return 2; }
}

process.exitCode = await main();
