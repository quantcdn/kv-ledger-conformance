// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Byte layout of the ledger hashes (genesis, entry, digest genesis).
import { createHash } from 'node:crypto';

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

export const instanceName = (org, store, collection, shard) => `${org}/${store}/${collection}#${shard}`;

export const genesisHash = (instance, definitionHash) =>
  sha256Hex(`qkv-ledger-v1 genesis\n${instance}\n${definitionHash}`);

export const digestGenesisHash = (org, store) => sha256Hex(`qkv-digest-v1 genesis\n${org}/${store}`);

export function entryHash({ prevHash, instance, seq, id, at, stored }) {
  const valueHash = sha256Hex(Buffer.from(stored, 'utf8'));
  return sha256Hex(`qkv-ledger-v1\n${prevHash}\n${instance}\n${seq}\n${id}\n${at}\n${valueHash}`);
}
