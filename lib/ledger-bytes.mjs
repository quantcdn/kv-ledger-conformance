// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Byte layout of the KV ledger identity: hashes, JCS, Merkle tree (RFC 6962) and audit paths (RFC 9162).
// Independent of the verifier tool.
import { createHash } from 'node:crypto';

const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// JCS (RFC 8785) for JSON values: keys sorted by UTF-16 code units, no whitespace.
const jcsByType = {
  string: (v) => JSON.stringify(v),
  boolean: (v) => JSON.stringify(v),
  number(v) {
    if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(v);
  },
  object(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  },
};

export function canonicalJson(value) {
  const fn = jcsByType[typeof value];
  if (!fn) throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  return fn(value);
}

export const definitionHash = (definition) => sha256Hex(utf8(canonicalJson(definition)));
export const instanceName = (org, store, collection, shard) => `${org}/${store}/${collection}#${shard}`;
export const genesisHash = (instance, defHash) => sha256Hex(utf8(`qkv-ledger-v1 genesis\n${instance}\n${defHash}`));
export const digestGenesisHash = (org, store) => sha256Hex(utf8(`qkv-digest-v1 genesis\n${org}/${store}`));

export function entryHash({ prevHash, instance, seq, id, at, stored }) {
  const valueHash = sha256Hex(utf8(stored));
  return sha256Hex(utf8(['qkv-ledger-v1', prevHash, instance, seq, id, at, valueHash].join('\n')));
}

const leafNode = (hex) => sha(Buffer.from([0]), Buffer.from(hex, 'hex'));
const innerNode = (left, right) => sha(Buffer.from([1]), left, right);

// Largest power of two strictly below n (n >= 2).
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function subtree(hashes) {
  if (hashes.length === 1) return leafNode(hashes[0]);
  const k = splitPoint(hashes.length);
  return innerNode(subtree(hashes.slice(0, k)), subtree(hashes.slice(k)));
}

export function merkleRoot(hashes) {
  if (hashes.length === 0) throw new RangeError('merkleRoot needs at least one hash');
  return subtree(hashes).toString('hex');
}

function pathFor(index, hashes) {
  if (hashes.length === 1) return [];
  const k = splitPoint(hashes.length);
  if (index < k) return [...pathFor(index, hashes.slice(0, k)), subtree(hashes.slice(k))];
  return [...pathFor(index - k, hashes.slice(k)), subtree(hashes.slice(0, k))];
}

export function auditPath(index, hashes) {
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) throw new RangeError('index out of range');
  return pathFor(index, hashes).map((b) => b.toString('hex'));
}

// One step of the RFC 9162 verification walk.
function step({ fn, sn, acc }, sibling) {
  if (fn % 2 === 1 || fn === sn) {
    let f = fn;
    let s = sn;
    while (f % 2 === 0 && f !== 0) { f /= 2; s = Math.floor(s / 2); }
    return { fn: Math.floor(f / 2), sn: Math.floor(s / 2), acc: innerNode(sibling, acc) };
  }
  return { fn: Math.floor(fn / 2), sn: Math.floor(sn / 2), acc: innerNode(acc, sibling) };
}

const HEX64 = /^[0-9a-f]{64}$/;

function inputsOk(leafHex, index, size, pathHex) {
  const sizeOk = Number.isSafeInteger(size) && size > 0;
  const indexOk = Number.isSafeInteger(index) && index >= 0 && index < size;
  return sizeOk && indexOk && HEX64.test(leafHex) && pathHex.every((h) => HEX64.test(h));
}

// Returns the root as hex, or undefined when the path does not fit the index and size.
export function rootFromAuditPath(leafHex, index, size, pathHex) {
  if (!inputsOk(leafHex, index, size, pathHex)) return undefined;
  let state = { fn: index, sn: size - 1, acc: leafNode(leafHex) };
  for (const hex of pathHex) {
    if (state.sn === 0) return undefined;
    state = step(state, Buffer.from(hex, 'hex'));
  }
  return state.sn === 0 ? state.acc.toString('hex') : undefined;
}
