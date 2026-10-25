// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// verifyChain from kvstore.d.ts (ChainReport) and the API page "verifyChain" section. Pure: edge-surface.mjs checks
// the input type and size first.
//
// Method: put every entry in a bucket per shard (keyed by String(shard), so 1 and '1' are one shard; the bucket
// keeps the first shard value it saw). A bucket maps seq -> (hash -> prevHash), so an entry repeated with the same
// seq and hash is stored once. Then walk each bucket's seqs in ascending order. At each seq the text-smallest hash
// is the link the chain follows; every further hash at that seq is a 'fork'.

const isText = (v) => typeof v === 'string';

// One test per chain field. An entry that fails any of them is reported as 'missing-fields'.
const FIELD_TESTS = Object.freeze({
  shard: (v) => isText(v) || (typeof v === 'number' && Number.isFinite(v)),
  seq: (v) => Number.isSafeInteger(v) && v > 0,
  hash: isText,
  prevHash: isText,
});

// List items and getEntry results hold the chain fields in a `ledger` object; receipts hold them at the top.
function linkOf(entry) {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const holder = typeof entry.ledger === 'object' && entry.ledger !== null ? entry.ledger : entry;
  const complete = Object.entries(FIELD_TESTS).every(([field, valid]) => valid(holder[field]));
  return complete ? holder : undefined;
}

function addToBucket(buckets, link) {
  const name = String(link.shard);
  if (!buckets.has(name)) buckets.set(name, { shard: link.shard, seqs: new Map() });
  const { seqs } = buckets.get(name);
  if (!seqs.has(link.seq)) seqs.set(link.seq, new Map());
  const atSeq = seqs.get(link.seq);
  if (!atSeq.has(link.hash)) atSeq.set(link.hash, link.prevHash);
}

// The problem between the last accepted link (tip) and the chosen link at `seq`, or null.
function joinProblem(tip, seq, prevHash) {
  if (seq !== tip.seq + 1) return 'gap';
  return prevHash === tip.hash ? null : 'broken-link';
}

function walkBucket({ shard, seqs }, problems) {
  const order = [...seqs.keys()].sort((a, b) => a - b);
  let tip = null;
  let count = 0;
  for (const seq of order) {
    const atSeq = seqs.get(seq);
    const [chosen, ...others] = [...atSeq.keys()].sort();
    count += 1 + others.length;
    const problem = tip === null ? null : joinProblem(tip, seq, atSeq.get(chosen));
    if (problem !== null) problems.push({ problem, shard, seq });
    for (let i = 0; i < others.length; i += 1) problems.push({ problem: 'fork', shard, seq });
    tip = { seq, hash: chosen };
  }
  return { shard, first: order[0], last: order[order.length - 1], count };
}

export function verifyChainEntries(entries) {
  const problems = [];
  const buckets = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const link = linkOf(entries[index]);
    if (link === undefined) problems.push({ problem: 'missing-fields', index });
    else addToBucket(buckets, link);
  }
  const names = [...buckets.keys()].sort();
  const shards = names.map((name) => walkBucket(buckets.get(name), problems));
  return { ok: problems.length === 0, checked: shards.reduce((total, s) => total + s.count, 0), shards, problems };
}
