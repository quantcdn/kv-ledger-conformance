// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Entry ids and shard choice. An id is a 26-character Crockford base32 ULID (10 characters of time in epoch ms,
// 16 characters of an 80-bit random part) plus '-' and the two-digit shard. Within a shard the id always grows:
// when the time does not move forward, the time stays and the random part grows by one.
// The shard comes from a seeded generator (mulberry32), so one seed gives one shard sequence.
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LIMIT = 1n << 80n;

function base32(value, length) {
  let n = BigInt(value);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[Number(n % 32n)] + out;
    n /= 32n;
  }
  return out;
}

export const shardName = (n) => String(n).padStart(2, '0');

const freshRandom = () => BigInt(`0x${randomBytes(10).toString('hex')}`);

/**
 * The next id of a shard. last: { at, random (decimal text) } of the shard head, or null.
 * Returns { id, at, random } (random as decimal text, JSON-safe).
 */
export function nextId(now, last, shard) {
  const forward = last === null || now > last.at;
  let at = forward ? now : last.at;
  let random = forward ? freshRandom() : BigInt(last.random) + 1n;
  if (random >= RANDOM_LIMIT) {
    at += 1;
    random = 0n;
  }
  return { id: `${base32(at, 10)}${base32(random, 16)}-${shardName(shard)}`, at, random: random.toString() };
}

/** mulberry32 step: returns [a float in [0, 1), the next state]. */
export function nextRandom(state) {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}
