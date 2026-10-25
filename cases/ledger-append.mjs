// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// ledger/append: receipts, chains, genesis and the append chain per shard.
import assert from 'node:assert/strict';
import {
  COLLECTION, HEX64, LEDGER, SHARD, appendMany, assertShardChains, byShard, declare, genesisOf, ledgerCase,
} from './ledger-util.mjs';

function assertSource(source) {
  if (source === undefined) return;
  assert.equal(typeof source, 'object', 'source is an object');
  assert.equal(typeof source.type, 'string', 'source.type');
  assert.equal(typeof source.principal, 'string', 'source.principal');
}

async function receiptShape(ctx) {
  await declare(ctx, { chains: 4 });
  const r = await ctx.kv.append(COLLECTION, { action: 'login' });
  assert.equal(r.key, `${COLLECTION}:${r.id}`, 'key = collection + ":" + id');
  assert.match(r.shard, SHARD, 'shard is two digits');
  assert.ok(Number(r.shard) < 4, 'shard within the chains');
  assert.ok(r.id.endsWith(`-${r.shard}`), 'id ends with "-" + shard');
  assert.match(r.id, new RegExp(`^[0-9A-HJKMNP-TV-Z]{26}-${r.shard}$`), 'id is a 26-character ULID, "-" and the shard');
  assert.ok(!r.id.includes(':'), 'id has no ":"');
  assert.equal(r.seq, 1);
  assert.ok(Number.isSafeInteger(r.at) && r.at > 1e12, `at is epoch ms, got ${r.at}`);
  assert.match(r.hash, HEX64);
  assert.match(r.prevHash, HEX64);
  assert.equal(r.ledger, LEDGER);
  assert.notEqual(r.replayed, true, 'a first append is not replayed');
  assertSource(r.source);
}

async function genesis(ctx) {
  const declared = await declare(ctx, { chains: 2 });
  assert.equal(declared.definitionHash, ctx.ledgerBytes.definitionHash(declared.definition),
    'definitionHash = SHA-256 of the JCS of the definition');
  assert.equal(declared.definition.v, 1);
  const r = await ctx.kv.append(COLLECTION, { a: 1 });
  assert.equal(r.prevHash, genesisOf(ctx, declared, COLLECTION, r.shard), 'seq 1 prevHash is the genesis hash');
}

async function chainLinks(ctx) {
  const declared = await declare(ctx, { chains: 1 });
  const receipts = await appendMany(ctx, 6);
  assert.deepEqual(receipts.map((r) => r.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(receipts.map((r) => String(r.shard))).size, 1, 'one shard');
  assertShardChains(ctx, declared, receipts);
}

async function perShardChains(ctx) {
  const declared = await declare(ctx, { chains: 4 });
  const receipts = await appendMany(ctx, 20);
  for (const shard of byShard(receipts).keys()) {
    assert.match(shard, SHARD);
    assert.ok(Number(shard) < 4, `shard ${shard} within 00..03`);
  }
  assertShardChains(ctx, declared, receipts);
}

async function noLedger(ctx) {
  await ctx.expectKVError(() => ctx.kv.append('nowhere', { a: 1 }),
    { code: 'LEDGER_NOT_FOUND', status: 404, retryable: false });
}

async function pending(ctx) {
  const declared = await declare(ctx, {}, { wait: false });
  assert.equal(declared.state, 'PENDING');
  assert.ok(declared.activeAfter !== undefined, 'activeAfter on a PENDING declare');
  await ctx.expectKVError(() => ctx.kv.append(COLLECTION, { a: 1 }), {
    code: 'LEDGER_NOT_READY', status: 409, retryable: true,
    details: { activeAfter: 'present', idempotencyKey: ctx.limits.idempotencyKey.autoPattern },
  });
}

export const ledgerAppendCases = [
  ledgerCase('receipt-shape', receiptShape),
  ledgerCase('genesis', genesis),
  ledgerCase('chain-links', chainLinks),
  ledgerCase('per-shard-chains', perShardChains),
  ledgerCase('no-ledger', noLedger),
  ledgerCase('pending', pending),
];
