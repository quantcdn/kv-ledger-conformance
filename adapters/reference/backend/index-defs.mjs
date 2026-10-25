// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Index definitions (stores page "Declaring an Index"): the definition rules, collection patterns, membership,
// group tuples and the sortBy order. Pure functions: nothing here touches the store.
import { LIMITS } from '../../../lib/limits.mjs';
import { byteCompare, isIntIn, isPlainObject, isScalar } from '../../../lib/check-util.mjs';

const isFieldName = (v) => typeof v === 'string' && LIMITS.fieldName.test(v) && !LIMITS.reservedFieldNames.includes(v);
const isPattern = (v) => typeof v === 'string' && v.length > 0 && v.split(':').every((segment) => segment.length > 0);
const isFlag = (v) => v === undefined || typeof v === 'boolean';
const KNOWN = new Set(['name', 'collection', 'fields', 'sortBy', 'unique', 'count']);

// [problem, (def) => true when the rule is broken]
const RULES = [
  ['unknown index property', (d) => Object.keys(d).some((name) => !KNOWN.has(name))],
  ['invalid index name', (d) => typeof d.name !== 'string' || !LIMITS.indexName.test(d.name)],
  ['collection must be a pattern of non-empty segments', (d) => !isPattern(d.collection)],
  ['fields must be 0 to 3 field names', (d) => !Array.isArray(d.fields) || !isIntIn(d.fields.length, LIMITS.indexFields)],
  ['invalid field name', (d) => Array.isArray(d.fields) && !d.fields.every(isFieldName)],
  ['a field appears twice', (d) => Array.isArray(d.fields) && new Set(d.fields).size !== d.fields.length],
  ['invalid sortBy field', (d) => d.sortBy !== undefined && !isFieldName(d.sortBy)],
  ['unique and count must be booleans', (d) => !isFlag(d.unique) || !isFlag(d.count)],
  ['unique and count are exclusive', (d) => d.unique === true && d.count === true],
  ['a unique index needs at least one field', (d) => d.unique === true && Array.isArray(d.fields) && d.fields.length === 0],
];

/** The problem text of a definition, or null. */
export function definitionProblem(def) {
  if (!isPlainObject(def)) return 'the index definition must be an object';
  const rule = RULES.find(([, broken]) => broken(def));
  return rule === undefined ? null : rule[0];
}

/** A complete definition: { name, collection, fields, sortBy?, unique, count }. */
export function normalized(def) {
  const out = { name: def.name, collection: def.collection, fields: [...def.fields], unique: def.unique === true,
    count: def.count === true };
  if (def.sortBy !== undefined) out.sortBy = def.sortBy;
  return out;
}

/** True when the collection pattern (with '*' for one whole segment) covers the collection. */
export function covers(pattern, collection) {
  const want = pattern.split(':');
  const have = collection.split(':');
  return want.length === have.length && want.every((segment, i) => segment === '*' || segment === have[i]);
}

/** The group tuple of a value for the fields, or null when the value is not in the index. */
export function tupleOf(fields, value) {
  if (!isPlainObject(value)) return null;
  const complete = fields.every((field) => Object.hasOwn(value, field) && isScalar(value[field]));
  return complete ? JSON.stringify(fields.map((field) => value[field])) : null;
}

/** The tuple an equals object asks for, or null when its fields are not exactly the index fields. */
export function tupleOfEquals(fields, equals = {}) {
  const names = Object.keys(equals);
  const exact = names.length === fields.length && fields.every((field) => Object.hasOwn(equals, field));
  return exact ? JSON.stringify(fields.map((field) => equals[field])) : null;
}

// sortBy order: a missing value first, then null, booleans, numbers, strings (UTF-8 byte order).
const RANKS = { boolean: 2, number: 3, string: 4 };
const rankOf = (v) => (v === undefined ? 0 : v === null ? 1 : RANKS[typeof v]);

const SAME_RANK = {
  2: (a, b) => Number(a) - Number(b),
  3: (a, b) => a - b,
  4: (a, b) => byteCompare(a, b),
};

/** Compares two sortBy values (or keys, as strings). */
export function compareValues(a, b) {
  const [ra, rb] = [rankOf(a), rankOf(b)];
  if (ra !== rb) return ra - rb;
  const same = SAME_RANK[ra];
  return same === undefined ? 0 : Math.sign(same(a, b));
}

/** The order position of a member: [sort value or key, key]. JSON-safe (a missing value is held as a flag). */
export function positionOf(def, key, value) {
  const sort = def.sortBy === undefined ? key : value[def.sortBy];
  return sort === undefined ? { missing: true, key } : { sort, key };
}

const sortOf = (position) => (position.missing ? undefined : position.sort);

export function comparePositions(a, b) {
  return compareValues(sortOf(a), sortOf(b)) || byteCompare(a.key, b.key);
}
