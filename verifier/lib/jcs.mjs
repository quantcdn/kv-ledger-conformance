// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// RFC 8785 canonical JSON for the value shapes the ledger hashes.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return number(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') return members(value);
  throw new TypeError('canonicalJson: unsupported ' + typeof value);
}

function number(n) {
  if (!Number.isFinite(n)) throw new TypeError('canonicalJson: non-finite number');
  return JSON.stringify(n);
}

// Default sort compares UTF-16 code units, which is the JCS key order.
function members(obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
