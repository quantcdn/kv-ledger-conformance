// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Reads the downloaded archive: ledgers/<org>/<store>/<ledger>/<collection b64url>/<shard>/<object>.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

// The archive job writes only <period>-<fromSeq>-<toSeq>.jsonl.gz with 1 <= fromSeq <= toSeq.
const OBJECT = /^(\d{8}T\d{4}Z)-(\d{12})-(\d{12})\.jsonl\.gz$/;
const SHARD = /^\d{2}$/;
// A folder is a collection only when it is the exact base64url of that collection.
const collectionOf = (seg) => { const c = Buffer.from(seg, 'base64url').toString('utf8'); return Buffer.from(c, 'utf8').toString('base64url') === seg ? c : undefined; };

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function parseLine(text) {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch { return undefined; }
}

// A corrupt object or line is reported as `unreadable` / `badLines`, not thrown.
function readObject(file) {
  let text;
  try { text = gunzipSync(readFileSync(file)).toString('utf8'); } catch { return { lines: [], unreadable: true, badLines: 0 }; }
  const parsed = text.split('\n').filter((l) => l.length > 0).map(parseLine);
  return { lines: parsed.filter((l) => l !== undefined), unreadable: false, badLines: parsed.filter((l) => l === undefined).length };
}

// An archive object, or a key the archive job never writes (junk: { junk: true, ... }).
// Where a key sits: org, store, ledger, collection and shard. A non-canonical collection folder is one result
// (shard ''), whatever it holds.
function whereOf([, org, store, ledger, enc, shard], collection) {
  if (collection === undefined) return { org, store, ledger, collection: enc, shard: '' };
  return { org, store, ledger, collection, shard: shard ?? '' };
}

// The object range of a name at an object position, or undefined.
function objectRange(parts, collection) {
  const m = parts.length === 7 ? OBJECT.exec(parts[6]) : null;
  if (!m || collection === undefined || !SHARD.test(parts[5])) return undefined;
  const fromSeq = Number(m[2]), toSeq = Number(m[3]);
  return fromSeq >= 1 && toSeq >= fromSeq ? { period: m[1], fromSeq, toSeq } : undefined;
}

function describe(root, file) {
  const parts = file.slice(root.length + 1).split(sep);
  if (parts.length < 5 || parts[0] !== 'ledgers') return undefined;
  const collection = collectionOf(parts[4]);
  const where = whereOf(parts, collection);
  const range = objectRange(parts, collection);
  if (range) return { ...where, ...range, file };
  // Junk inside a real shard folder fails that shard; elsewhere it is a result of its own.
  return { ...where, junk: true, inShard: collection !== undefined && parts.length >= 7 && SHARD.test(parts[5]) };
}

export const shardId = (s) => `${s.org}/${s.store}/${s.ledger}/${s.collection}#${s.shard}`;

// Returns Map<shardId, { org, store, ledger, collection, shard, objects: [{ period, fromSeq, toSeq, lines }] }>.
export const archiveExists = (dir, org, store) => existsSync(join(dir, 'ledgers', org, store));

const newShard = (d) => ({ org: d.org, store: d.store, ledger: d.ledger, collection: d.collection, shard: d.shard, objects: [] });
export function readArchive(dir, org, store) {
  const root = join(dir, 'ledgers', org, store);
  const shards = new Map();
  shards.junk = new Map();
  if (!existsSync(root)) return shards;
  for (const file of walk(root).sort()) {
    const d = describe(dir, file);
    if (!d) continue;
    const id = shardId(d);
    if (d.junk && !d.inShard) { shards.junk.set(id, newShard(d)); continue; }
    if (!shards.has(id)) shards.set(id, newShard(d));
    if (d.junk) shards.get(id).junk = true;
    else shards.get(id).objects.push({ period: d.period, fromSeq: d.fromSeq, toSeq: d.toSeq, ...readObject(file) });
  }
  for (const s of shards.values()) { markForks(s.objects); s.objects.sort((a, b) => a.fromSeq - b.fromSeq); }
  return shards;
}

// The first seq that o shares with the (merged, sorted) seq ranges of the objects before it, if any.
function firstShared(ranges, o) {
  for (const r of ranges) {
    const lo = Math.max(r.fromSeq, o.fromSeq);
    if (lo <= Math.min(r.toSeq, o.toSeq)) return lo;
  }
  return undefined;
}
function addRange(ranges, o) {
  const all = [...ranges, { fromSeq: o.fromSeq, toSeq: o.toSeq }].sort((a, b) => a.fromSeq - b.fromSeq);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.fromSeq <= last.toSeq + 1) last.toSeq = Math.max(last.toSeq, r.toSeq);
    else out.push({ ...r });
  }
  return out;
}
// Ruling F10: in key order (the order the bucket lists them), an object whose seqs overlap an earlier
// object of the shard is a fork. It gets `fork` = the first overlapping seq and is not checked further.
export function markForks(objects) {
  let ranges = [];
  for (const o of objects) {
    const at = firstShared(ranges, o);
    if (at === undefined) ranges = addRange(ranges, o);
    else o.fork = at;
  }
}
