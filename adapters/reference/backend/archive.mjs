// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The simulated archive of the local backend (spec 9.1; ledgers page "Archive, Digests and Lock Modes",
// "Inclusion Proof", "Byte Layout (Version 1)"). It fills the archive seam of ledgers.mjs.
// One archive object per shard per 5-minute UTC period (at most archiveObjectMaxEntries entries) holds that period's
// unarchived entries in seq order. Each run writes one signed digest per store per period that has new objects
// (`<period>`, or `<period>_<n>` when that period already has a digest); digests chain by prevDigestHash from the
// digest genesis. A run happens on archiveNow (every unarchived entry) or lazily at a status or proof call (the
// periods that ended at least archiveDelayMs ago). Only key strings exist: no object or digest file is written.
// store.archives: Map `${collection}#${shard}` -> [{ ledger, period, fromSeq, toSeq, merkleRoot, headHash,
// archiveKey, digestName, writtenAt }]. store.digests: Map name -> { digest, signature } in write order.
import { LIMITS } from '../../../lib/limits.mjs';
import { auditPath, canonicalJson, digestGenesisHash, merkleRoot, sha256Hex } from '../../../lib/ledger-bytes.mjs';
import { byteCompare } from '../../../lib/check-util.mjs';

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const periodStart = (at) => Math.floor(at / LIMITS.archivePeriodMs) * LIMITS.archivePeriodMs;
/** The period label YYYYMMDDTHHmmZ of a period start. */
export const periodLabel = (start) => iso(start).replace(/[-:]/g, '').slice(0, 13).concat('Z');
const pad12 = (n) => String(n).padStart(12, '0');
const chainIdOf = (chain) => `${chain.collection}#${chain.shard}`;
const lastOf = (list) => list[list.length - 1];

// Unarchived entries of a chain cut into objects: runs of one period, in seq order, up to the entry limit.
// Stops at the first entry whose period is not ready (its end + delay after `cutoff`).
function pendingObjects(store, chain, fromSeq, cutoff) {
  const runs = [];
  for (const key of chain.keys.slice(fromSeq - 1)) {
    const link = store.items.get(key).ledger;
    const start = periodStart(link.at);
    if (start + LIMITS.archivePeriodMs + LIMITS.archiveDelayMs > cutoff) break;
    const run = lastOf(runs);
    const fits = run !== undefined && run.period === start && run.links.length < LIMITS.archiveObjectMaxEntries;
    if (fits) run.links.push(link);
    else runs.push({ chain, period: start, links: [link] });
  }
  return runs;
}

const byPlace = (a, b) => byteCompare(a.collection, b.collection) || byteCompare(a.shard, b.shard)
  || a.fromSeq - b.fromSeq;

export function createArchive(core, signer) {
  const objectsOf = (store, chain) => store.archives.get(chainIdOf(chain)) ?? [];

  function archivedSeq(store, chain) {
    return lastOf(objectsOf(store, chain))?.toSeq ?? 0;
  }

  function objectOf(store, run) {
    const { chain, period, links } = run;
    const fromSeq = links[0].seq;
    const toSeq = lastOf(links).seq;
    const collection64 = Buffer.from(chain.collection, 'utf8').toString('base64url');
    const archiveKey = `ledgers/${core.org}/${store.id}/${chain.ledger}/${collection64}/${chain.shard}/`
      + `${periodLabel(period)}-${pad12(fromSeq)}-${pad12(toSeq)}.jsonl.gz`;
    return { ledger: chain.ledger, collection: chain.collection, shard: chain.shard, period, fromSeq, toSeq,
      merkleRoot: merkleRoot(links.map((l) => l.hash)), headHash: lastOf(links).hash, archiveKey };
  }

  function ledgersBlock(store, objects) {
    const names = [...new Set(objects.map((o) => o.ledger))].sort(byteCompare);
    return names.map((name) => {
      const entry = store.ledgers.get(name);
      const instances = objects.filter((o) => o.ledger === name).sort(byPlace)
        .map(({ collection, shard, fromSeq, toSeq, headHash, merkleRoot: root, archiveKey }) => (
          { collection, shard, fromSeq, toSeq, headHash, merkleRoot: root, archiveKey }));
      return { name, definitionHash: entry.definitionHash, definition: structuredClone(entry.definition), instances };
    });
  }

  // The period label, or `<label>_<n>` (six digits) for a supplementary digest of that period.
  function digestName(store, period) {
    const label = periodLabel(period);
    const nameAt = (n) => (n === 0 ? label : `${label}_${String(n).padStart(6, '0')}`);
    let n = 0;
    while (store.digests.has(nameAt(n))) n += 1;
    return nameAt(n);
  }

  function prevDigestHash(store) {
    const last = lastOf([...store.digests.values()]);
    return last === undefined ? digestGenesisHash(core.org, store.id)
      : sha256Hex(Buffer.from(canonicalJson(last.digest), 'utf8'));
  }

  function writeDigest(store, period, objects) {
    const name = digestName(store, period);
    const now = core.now();
    const digest = { v: 1, org: core.org, store: store.id,
      period: { start: iso(period), end: iso(period + LIMITS.archivePeriodMs) },
      prevDigestHash: prevDigestHash(store), ledgers: ledgersBlock(store, objects), signedAt: iso(now) };
    store.digests.set(name, { digest, signature: signer.sign(digest) });
    for (const object of objects) {
      const id = `${object.collection}#${object.shard}`;
      store.archives.set(id, [...(store.archives.get(id) ?? []), { ...object, digestName: name, writtenAt: now }]);
    }
  }

  /** One archive run over the periods ready at `cutoff` (Infinity: every unarchived entry). */
  function runArchive(store, cutoff) {
    const objects = [...store.chains.values()]
      .flatMap((chain) => pendingObjects(store, chain, archivedSeq(store, chain) + 1, cutoff))
      .map((run) => objectOf(store, run));
    const periods = [...new Set(objects.map((o) => o.period))].sort((a, b) => a - b);
    for (const period of periods) writeDigest(store, period, objects.filter((o) => o.period === period));
  }

  const refresh = (store) => runArchive(store, core.now());
  const archiveNow = (store) => runArchive(store, Infinity);

  function proofOf(store, ledgerEntry, key, record) {
    const link = record.ledger;
    const chain = store.chains.get(`${link.collection}#${link.shard}`);
    const object = objectsOf(store, chain).find((o) => o.fromSeq <= link.seq && link.seq <= o.toSeq);
    if (object === undefined) return { status: 'pending' };
    const hashes = chain.keys.slice(object.fromSeq - 1, object.toSeq).map((k) => store.items.get(k).ledger.hash);
    const leafIndex = link.seq - object.fromSeq;
    const { digest, signature } = store.digests.get(object.digestName);
    const entry = { key, collection: link.collection, shard: link.shard, id: link.id, seq: link.seq, at: link.at,
      value: record.stored, prevHash: link.prevHash, hash: link.hash };
    const proof = { status: 'archived', entry, hash: link.hash, period: periodLabel(object.period),
      archiveKey: object.archiveKey, leafIndex, treeSize: hashes.length, merkleRoot: object.merkleRoot,
      auditPath: auditPath(leafIndex, hashes), digest: structuredClone(digest),
      digestKey: `digests/${core.org}/${store.id}/${object.digestName}.json`, signature, keyId: signer.keyId,
      digestSignedAt: digest.signedAt };
    if (link.source !== undefined) proof.source = { ...link.source };
    return proof;
  }

  /** The retention end (epoch ms) of a ledger's archive objects, or null when none is written. */
  function retainUntil(store, ledgerEntry) {
    const days = ledgerEntry.definition.retentionDays;
    const ends = [...store.archives.values()].flat().filter((o) => o.ledger === ledgerEntry.definition.name)
      .map((o) => o.writtenAt + days * DAY_MS);
    return ends.length === 0 ? null : Math.max(...ends);
  }

  return { archivedSeq, proofOf, refresh, archiveNow, retainUntil };
}
