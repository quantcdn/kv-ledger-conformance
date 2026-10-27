// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Item versions in the shape the platform gives: a ULID, 26 characters of Crockford base32 (48-bit millisecond time,
// then 80 random bits). This one is monotonic in one process: in the same millisecond, or when the clock moves back,
// the random part goes up by one, so versions sort in the order of the writes.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIME = 2 ** 48 - 1;
const RANDOM_MAX = (1n << 80n) - 1n;

function encode(value, length) {
  let out = '';
  for (let v = BigInt(value), i = 0; i < length; i += 1, v >>= 5n) out = ALPHABET[Number(v & 31n)] + out;
  return out;
}

const randomPart = () => BigInt(`0x${randomBytes(10).toString('hex')}`);

/** A function that makes monotonic ULIDs for the time it is given (epoch ms). */
export function createUlid() {
  let lastTime = -1;
  let lastRandom = 0n;
  return function ulid(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME) throw new RangeError('ulid time out of range');
    const repeat = nowMs <= lastTime && lastRandom < RANDOM_MAX;
    lastTime = repeat ? lastTime : nowMs;
    lastRandom = repeat ? lastRandom + 1n : randomPart();
    return encode(lastTime, 10) + encode(lastRandom, 16);
  };
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
