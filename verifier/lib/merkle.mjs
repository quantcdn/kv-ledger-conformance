// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// RFC 6962 Merkle tree over the raw 32-byte entry hashes; RFC 9162 path check.
import { createHash } from 'node:crypto';

const h = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const leaf = (hex) => h(Buffer.from([0]), Buffer.from(hex, 'hex'));
const pair = (l, r) => h(Buffer.from([1]), l, r);
function split(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function tree(hs) {
  if (hs.length === 1) return leaf(hs[0]);
  const k = split(hs.length);
  return pair(tree(hs.slice(0, k)), tree(hs.slice(k)));
}

export function merkleRoot(hashes) {
  if (hashes.length === 0) throw new RangeError('merkleRoot needs at least one entry');
  return tree(hashes).toString('hex');
}

function path(m, hs) {
  if (hs.length === 1) return [];
  const k = split(hs.length);
  if (m < k) return [...path(m, hs.slice(0, k)), tree(hs.slice(k))];
  return [...path(m - k, hs.slice(k)), tree(hs.slice(0, k))];
}

export function auditPath(index, hashes) {
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) throw new RangeError('index out of range');
  return path(index, hashes).map((b) => b.toString('hex'));
}

function climb(state, sibling) {
  let { fn, sn, r } = state;
  if ((fn & 1) === 1 || fn === sn) {
    r = pair(sibling, r);
    while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
  } else {
    r = pair(r, sibling);
  }
  return { fn: fn >> 1, sn: sn >> 1, r };
}

const HASH = /^[0-9a-f]{64}$/;

// The index is inside a tree of a positive size, and every hash is 64 hex characters.
function auditInputOk(leafHashHex, index, size, auditPathHex) {
  const sizeOk = Number.isSafeInteger(size) && size > 0;
  const indexOk = sizeOk && Number.isSafeInteger(index) && index >= 0 && index < size;
  return indexOk && HASH.test(leafHashHex) && auditPathHex.every((h) => HASH.test(h));
}

export function rootFromAuditPath(leafHashHex, index, size, auditPathHex) {
  if (!auditInputOk(leafHashHex, index, size, auditPathHex)) return undefined;
  let state = { fn: index, sn: size - 1, r: leaf(leafHashHex) };
  for (const hex of auditPathHex) {
    if (state.sn === 0) return undefined;
    state = climb(state, Buffer.from(hex, 'hex'));
  }
  return state.sn === 0 ? state.r.toString('hex') : undefined;
}
