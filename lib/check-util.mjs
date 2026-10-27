// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Pure predicates for the edge-layer checks. Nothing here throws: callers turn a problem into a KVError.
import { LIMITS, EXPIRY_HINT } from './limits.mjs';

export const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');
export const isBoolean = (v) => typeof v === 'boolean';
export const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
export const inRange = (n, min, max) => n >= min && n <= max;
export const isIntIn = (v, { min, max }) => Number.isInteger(v) && inRange(v, min, max);
export const isTtl = (v) => isIntIn(v, LIMITS.ttl);
export const isAmount = (v) => Number.isSafeInteger(v) && v !== 0;
export const byteCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// The Object.prototype of another realm (for example a node:vm context): its own prototype is null and its
// constructor is a function named Object.
function isForeignObjectPrototype(proto) {
  return Object.getPrototypeOf(proto) === null && typeof proto.constructor === 'function'
    && proto.constructor.name === 'Object';
}

/** A plain object of any realm: prototype Object.prototype or null. Arrays, dates and class instances are not. */
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) return true;
  return Object.prototype.toString.call(v) === '[object Object]' && isForeignObjectPrototype(proto);
}

export function isScalar(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  return typeof v === 'number' && Number.isFinite(v);
}

// where/equals rules of the stores page: a field name matches LIMITS.fieldName and is not reserved; a string value
// has at most LIMITS.fieldStringMaxChars characters.
const isFieldName = (name) => LIMITS.fieldName.test(name) && !LIMITS.reservedFieldNames.includes(name);
const isFieldValue = (v) => isScalar(v) && (typeof v !== 'string' || v.length <= LIMITS.fieldStringMaxChars);
const isField = ([name, value]) => isFieldName(name) && isFieldValue(value);

/** A plain object of min..max fields (where or equals), each a valid field name with a scalar value. */
export function isScalarMap(v, min, max) {
  if (!isPlainObject(v)) return false;
  const fields = Object.entries(v);
  return inRange(fields.length, min, max) && fields.every(isField);
}

/** Problem text for a key, or null. Format 2 adds the colon-edge and id-length rules. */
export function keyProblem(key, format = 2) {
  if (!isNonEmptyString(key)) return 'key must be a non-empty string';
  if (utf8Bytes(key) > LIMITS.keyMaxBytes) return 'key is over the key byte limit';
  if (format !== 2) return null;
  if (key.startsWith(':') || key.endsWith(':')) return 'key must not start or end with ":"';
  const id = key.slice(key.lastIndexOf(':') + 1);
  return utf8Bytes(id) > LIMITS.idMaxBytes ? 'the id (text after the last ":") is over the id byte limit' : null;
}

const UNKNOWN = Symbol('unknown option');

function optionProblem(name, value, spec) {
  if (LIMITS.expiryOptionNames.includes(name)) return { problem: `${name} is not an option`, hint: EXPIRY_HINT };
  if (!Object.hasOwn(spec, name)) return UNKNOWN;
  return spec[name](value) ? null : { problem: `option ${name} has an invalid value` };
}

/**
 * Checks an options object against a spec ({ name: predicate }). Undefined values count as absent.
 * Returns { problem, hint? } for the first bad option, else { unknown: [names not in the spec] }.
 */
export function scanOptions(opts, spec) {
  if (opts === undefined) return { unknown: [] };
  if (!isPlainObject(opts)) return { problem: 'options must be a plain object' };
  const unknown = [];
  for (const [name, value] of Object.entries(opts)) {
    if (value === undefined) continue;
    const result = optionProblem(name, value, spec);
    if (result === UNKNOWN) unknown.push(name);
    else if (result !== null) return result;
  }
  return { unknown };
}
