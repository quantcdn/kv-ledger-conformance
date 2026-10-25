// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
import { X509Certificate } from 'node:crypto';
// Offline verification of a downloaded ledger archive.
import { archiveExists, readArchive, shardId } from './archive.mjs';
import { checkAnchors, digestTrusted, readDigests } from './digest.mjs';
import { entryHash, genesisHash, instanceName } from './hash.mjs';
import { merkleRoot } from './merkle.mjs';

// Equal to DIGEST_GRACE_MS in the server's verify-archive.ts.
export const DIGEST_GRACE_MS = 3_600_000;
const PERIOD_MS = 300_000;

// The start (ms) of a period label 'YYYYMMDDTHHmmZ'; NaN for any other string.
function labelStart(label) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(label ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}
// Pending needs a period that has started (a future label is a renamed object) and is still inside the grace.
const inGrace = (obj, asOf) => labelStart(obj.period) <= asOf && asOf < labelStart(obj.period) + PERIOD_MS + DIGEST_GRACE_MS;

const fail = (seq, reason, extra) => ({ seq, reason, ...extra });

// Provenance: the writer of an entry is `source` inside its stored value (hashed with it). Read only from a line
// whose hash recomputes, so a summary never repeats a forged source. null = written before provenance existed.
function sourceOfValue(value) {
  try {
    const s = JSON.parse(value)?.source;
    return s && typeof s.type === 'string' && typeof s.principal === 'string' ? { type: s.type, principal: s.principal } : null;
  } catch { return null; }
}
function noteSource(line, ctx) {
  const source = sourceOfValue(line.value);
  const id = source ? `${source.type}\n${source.principal}` : '';
  const cur = ctx.sources.get(id) ?? { source, entries: 0 };
  cur.entries += 1; ctx.sources.set(id, cur);
  if (ctx.entryList) ctx.entryList.push({ collection: ctx.collection, shard: ctx.shard, seq: line.seq, key: line.key, hash: line.hash, source });
}

// Digest instance for one archive object, with the digest that carries it.
function indexDigests(digests) {
  const map = new Map();
  for (const d of digests) {
    for (const l of d.digest.ledgers ?? []) {
      for (const i of l.instances ?? []) {
        map.set(`${d.org}/${d.store}/${l.name}/${i.collection}#${i.shard}/${i.fromSeq}`, { d, ledger: l, inst: i });
      }
    }
  }
  return map;
}

function definitionHashFor(digests, shard) {
  for (const d of digests) {
    if (d.org !== shard.org || d.store !== shard.store) continue;
    const l = (d.digest.ledgers ?? []).find((x) => x.name === shard.ledger);
    if (l) return l.definitionHash;
  }
  return undefined;
}

function checkLine(line, ctx) {
  if (line.seq !== ctx.expected) {
    ctx.failures.push(fail(ctx.expected, 'missing_entry'));
  } else if (ctx.prevHash !== undefined && line.prevHash !== ctx.prevHash) {
    ctx.failures.push(fail(line.seq, 'hash_mismatch'));
  }
  const stored = { prevHash: line.prevHash, instance: ctx.instance, seq: line.seq, id: line.id, at: line.at, stored: line.value };
  if (entryHash(stored) !== line.hash) ctx.failures.push(fail(line.seq, 'hash_mismatch'));
  else noteSource(line, ctx);
  ctx.expected = line.seq + 1;
  ctx.prevHash = line.hash;
}

function checkFirst(first, ctx) {
  // No digest names the ledger (deleted or withheld): checkObject reports digest_mismatch, as the server does.
  if (first.seq !== 1 || ctx.genesis === undefined) return;
  if (first.prevHash !== ctx.genesis) ctx.failures.push(fail(1, 'hash_mismatch'));
}

function checkObject(obj, found, ctx) {
  const hashes = obj.lines.map((l) => l.hash);
  const last = obj.lines[obj.lines.length - 1];
  // No digest lists the object yet and its period closed less than the grace ago: pending, not a failure.
  if (!found && inGrace(obj, ctx.asOf)) {
    ctx.pending.push({ collection: ctx.collection, shard: ctx.shard, fromSeq: obj.fromSeq, toSeq: obj.toSeq });
    return;
  }
  if (!found || !digestTrusted(found.d)) {
    ctx.failures.push(found ? fail(obj.fromSeq, 'bad_signature') : fail(obj.fromSeq, 'digest_mismatch', { objectFromSeq: obj.fromSeq, objectToSeq: obj.toSeq }));
    if (!found) return;
  }
  const range = { objectFromSeq: obj.fromSeq, objectToSeq: obj.toSeq };
  if (!last) { ctx.failures.push(fail(obj.fromSeq, 'digest_mismatch', range)); return; }
  if (found.inst.headHash !== last.hash) ctx.failures.push(fail(last.seq, 'digest_mismatch', range));
  else if (found.inst.merkleRoot !== merkleRoot(hashes)) ctx.failures.push(fail(obj.fromSeq, 'digest_mismatch', range));
}

function shardContext(shard, digests, asOf, acc) {
  const defHash = definitionHashFor(digests, shard);
  const instance = instanceName(shard.org, shard.store, shard.collection, shard.shard);
  return { failures: [], expected: 1, prevHash: undefined, instance, genesis: defHash ? genesisHash(instance, defHash) : undefined,
    asOf, pending: [], collection: shard.collection, shard: shard.shard, sources: acc.sources, entryList: acc.entryList };
}

// Failures found before any line or digest check: a junk key in the shard folder, and forks.
function checkShardShape(shard, ctx) {
  // A key the archive job never writes, inside this shard's folder: the shard fails from seq 1.
  if (shard.junk) ctx.failures.push(fail(1, 'archive_mismatch'));
  // Ruling F10: a fork is archive_mismatch at the first overlapping seq, with the forked object's range,
  // before any line or digest check (the server reports the same).
  for (const obj of shard.objects.filter((o) => o.fork !== undefined)) {
    ctx.failures.push(fail(obj.fork, 'archive_mismatch', { objectFromSeq: obj.fromSeq, objectToSeq: obj.toSeq }));
  }
}

// A period label after asOf, or earlier than the object before it in the shard, is a renamed object.
// Returns the latest period start so far.
function checkPeriod(obj, prevStart, ctx) {
  const start = labelStart(obj.period);
  if (start > ctx.asOf || start < prevStart) ctx.failures.push(fail(obj.fromSeq, 'archive_mismatch'));
  return Number.isNaN(start) ? prevStart : Math.max(prevStart, start);
}

// The lines of one kept object; the number of lines.
function checkObjectLines(obj, isFirst, ctx) {
  if (isFirst && obj.lines[0]) checkFirst(obj.lines[0], ctx);
  if (obj.unreadable) ctx.failures.push(fail(obj.fromSeq, 'missing_entry'));
  if (obj.badLines) ctx.failures.push(fail(obj.fromSeq, 'hash_mismatch'));
  for (const line of obj.lines) checkLine(line, ctx);
  return obj.lines.length;
}

function verifyShard(shard, digests, byInstance, asOf, acc) {
  const ctx = shardContext(shard, digests, asOf, acc);
  const key = (o) => `${shard.org}/${shard.store}/${shard.ledger}/${shard.collection}#${shard.shard}/${o.fromSeq}`;
  checkShardShape(shard, ctx);
  let entries = 0;
  let prevStart = -Infinity;
  for (const [n, obj] of shard.objects.filter((o) => o.fork === undefined).entries()) {
    prevStart = checkPeriod(obj, prevStart, ctx);
    entries += checkObjectLines(obj, n === 0, ctx);
    checkObject(obj, byInstance.get(key(obj)), ctx);
  }
  return { entries, failures: ctx.failures, pending: ctx.pending };
}

// The file name gives the range when the first or last line of an object did not parse.
function edgeSeq(obj, name) {
  const intact = !obj.unreadable && !obj.badLines && obj.lines.length > 0;
  if (!intact) return obj[name];
  return name === 'fromSeq' ? obj.lines[0].seq : obj.lines[obj.lines.length - 1].seq;
}

function shardResult(shard, failures) {
  const first = shard.objects[0], last = shard.objects[shard.objects.length - 1];
  const base = { ledger: shard.ledger, collection: shard.collection, shard: shard.shard,
    fromSeq: first ? edgeSeq(first, 'fromSeq') : 0, toSeq: last ? edgeSeq(last, 'toSeq') : 0 };
  if (failures.length === 0) return { ...base, ok: true };
  const f = failures.reduce((a, b) => (b.seq < a.seq ? b : a));
  const range = f.objectFromSeq === undefined ? {} : { objectFromSeq: f.objectFromSeq, objectToSeq: f.objectToSeq };
  return { ...base, ok: false, firstBrokenSeq: f.seq, reason: f.reason, ...range };
}

// A digest instance whose archive object is absent is a missing entry.
function missingObjects(digests, shards) {
  const out = new Map();
  for (const d of digests) {
    for (const l of d.digest.ledgers ?? []) {
      for (const i of l.instances ?? []) {
        const meta = { org: d.org, store: d.store, ledger: l.name, collection: i.collection, shard: i.shard };
        const id = shardId(meta);
        if (shards.get(id)?.objects.some((o) => o.fromSeq === i.fromSeq)) continue;
        const cur = out.get(id) ?? { meta, failures: [] };
        cur.failures.push(fail(i.fromSeq, 'missing_entry'));
        out.set(id, cur);
      }
    }
  }
  return out;
}

function checkReceipts(receipts, shards) {
  const lines = new Map();
  for (const s of shards.values()) for (const o of s.objects) for (const l of o.lines) lines.set(l.key, l);
  const mismatched = [];
  for (const r of receipts) {
    const l = lines.get(r.key);
    if (!l || l.hash !== r.hash || l.seq !== r.seq || l.prevHash !== r.prevHash) mismatched.push(r.key);
  }
  return { checked: receipts.length, mismatched };
}

function parseStore(store) {
  const parts = typeof store === 'string' ? store.split('/') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts.some((p) => p === '.' || p === '..')) {
    throw new TypeError('store must be "<org>/<store>"');
  }
  return parts;
}

const sourceAcc = (listEntries) => ({ sources: new Map(), entryList: listEntries ? [] : undefined });
// sources: entries per writer, most first (source null = written before provenance existed); entryList on request.
function sourceResult(acc) {
  const order = (a, b) => b.entries - a.entries || JSON.stringify(a.source).localeCompare(JSON.stringify(b.source));
  return { sources: [...acc.sources.values()].sort(order), ...(acc.entryList ? { entryList: acc.entryList } : {}) };
}
// Every shard result: the shards of the archive, the digest instances with no archive object, and junk keys.
function shardResults(shards, digests, asOf, acc) {
  const byInstance = indexDigests(digests);
  const missing = missingObjects(digests, shards);
  const results = [];
  const pending = [];
  let entries = 0;
  for (const [id, shard] of shards) {
    const r = verifyShard(shard, digests, byInstance, asOf, acc);
    entries += r.entries;
    pending.push(...r.pending);
    results.push(shardResult(shard, [...r.failures, ...(missing.get(id)?.failures ?? [])]));
  }
  for (const [id, m] of missing) {
    if (!shards.has(id)) results.push(shardResult({ ...m.meta, objects: [] }, m.failures));
  }
  // Keys the archive job never writes outside a shard folder (a non-canonical collection folder, a bad
  // shard folder, a key directly under a ledger or collection folder): a failed result of their own.
  for (const j of shards.junk.values()) results.push(shardResult(j, [fail(1, 'archive_mismatch')]));
  return { results, pending, entries };
}

function addAnchors(out, digests, { anchorsDir, anchorCopiesDir, tsaRootsPem }, org, storeName) {
  const roots = tsaRootsPem && tsaRootsPem.map((p) => new X509Certificate(p));
  const { mode, tokenCheck, ...anchors } = checkAnchors(digests, anchorsDir, org, storeName, anchorCopiesDir, roots);
  out.anchors = anchors;
  out.anchorMode = mode; // 'bindings' or 'legacy' (last digest of the day)
  if (tokenCheck) out.anchorTokenCheck = tokenCheck; // always 'signature': a token that is not fully verified fails
}

// The final verdict: no strict pending, no mismatched receipt, no mismatched anchor, no unanchored day.
function finalOk(out, strict) {
  const strictPending = strict && out.pending.length > 0;
  const badReceipts = Boolean(out.receipts?.mismatched.length);
  const badAnchors = Boolean(out.anchors?.mismatched.length) || Boolean(out.anchors?.unanchoredDays?.length);
  return out.ok && !strictPending && !badReceipts && !badAnchors;
}

const orDefault = (value, fallback) => (value === undefined ? fallback : value);

// listEntries: also return entryList, one { collection, shard, seq, key, hash, source } per entry whose hash verifies.
export async function verifyArchive(options) {
  const { dir, publicKeyPem, store, receipts, anchorsDir } = options;
  const asOf = orDefault(options.asOf, Date.now());
  const [org, storeName] = parseStore(store);
  const digests = readDigests(dir, publicKeyPem, org, storeName);
  const present = archiveExists(dir, org, storeName);
  const shards = readArchive(dir, org, storeName);
  const acc = sourceAcc(orDefault(options.listEntries, false));
  const { results, pending, entries } = shardResults(shards, digests, asOf, acc);
  const out = { ok: present && results.every((s) => s.ok), store, entries, shards: results, pending, ...sourceResult(acc) };
  if (!present) out.reason = 'archive_missing';
  if (receipts) out.receipts = checkReceipts(receipts, shards);
  if (anchorsDir) addAnchors(out, digests, options, org, storeName);
  out.ok = finalOk(out, orDefault(options.strict, false));
  return out;
}
