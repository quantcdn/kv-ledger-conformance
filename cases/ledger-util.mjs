// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Helpers shared by the ledger case modules. Nothing here depends on the shard choice or on exact ids.
import assert from 'node:assert/strict';
import { byteCompare } from '../lib/check-util.mjs';

export const LEDGER = 'audit';
export const COLLECTION = 'audit';
export const HEX64 = /^[0-9a-f]{64}$/;
export const SHARD = /^\d{2}$/;

/** A ledger case; it declares a ledger. `extra` may set needs, shapes, declares or timeoutMs. */
export function ledgerCase(name, run, extra = {}) {
  return { name: `ledger/${name}`, tags: ['ledger'], needs: [], declares: ['ledger'], ...extra, run };
}

/** Declares the ledger (wait true by default). Returns the declare result. */
export async function declare(ctx, overrides = {}, { wait = true } = {}) {
  const def = { name: LEDGER, collection: COLLECTION, chains: 1, retentionDays: 1, ...overrides };
  return ctx.admin.declareLedger(ctx.storeId, def, { wait });
}

/** The genesis prevHash of seq 1 on a shard of a concrete collection (spec 7). */
export function genesisOf(ctx, declared, collection, shard) {
  const { genesisHash, instanceName } = ctx.ledgerBytes;
  return genesisHash(instanceName(ctx.identity.org, ctx.identity.store, collection, shard), declared.definitionHash);
}

/** n appends of { n: i } to the collection, one after the other. Returns the receipts. */
export async function appendMany(ctx, n, collection = COLLECTION, valueOf = (i) => ({ n: i })) {
  const receipts = [];
  for (let i = 0; i < n; i += 1) receipts.push(await ctx.kv.append(collection, valueOf(i)));
  return receipts;
}

/** Receipts grouped by String(shard), each group in append order. */
export function byShard(receipts) {
  const groups = new Map();
  for (const r of receipts) {
    const name = String(r.shard);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  return groups;
}

/** Each shard group chains from seq 1 without gaps, from its genesis hash. */
export function assertShardChains(ctx, declared, receipts, collection = COLLECTION) {
  for (const [shard, group] of byShard(receipts)) {
    group.forEach((r, i) => {
      assert.equal(r.seq, i + 1, `shard ${shard}: seq ${i + 1}`);
      const prev = i === 0 ? genesisOf(ctx, declared, collection, shard) : group[i - 1].hash;
      assert.equal(r.prevHash, prev, `shard ${shard} seq ${r.seq}: prevHash`);
    });
  }
}

/** Merge order of a ledger list: at, then shard, then id. */
export function compareMerge(a, b) {
  return (a.at - b.at) || byteCompare(String(a.shard), String(b.shard)) || byteCompare(a.id, b.id);
}

/** A proof is pending (status only, as the d.ts says) or archived. */
export function assertProofStatus(proof) {
  assert.ok(['pending', 'archived'].includes(proof.status), `proof status pending or archived, got ${proof.status}`);
  if (proof.status === 'pending') assert.deepEqual(Object.keys(proof), ['status'], 'a pending proof has only status');
}

/** The chain fields of a receipt or of a ledger block. */
export const linkOf = ({ id, shard, seq, at, hash, prevHash }) => ({ id, shard, seq, at, hash, prevHash });
