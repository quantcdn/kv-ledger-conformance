// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// list and search option rules (kvstore.d.ts QueryOptions/SearchOptions and the API page option table), as tables.
// queryProblem returns the text of the first broken rule, or null. It never throws.
import { LIMITS } from './limits.mjs';
import {
  isBoolean, isIntIn, isNonEmptyString, isPlainObject, isScalar, isScalarMap, byteCompare, utf8Bytes, inRange,
} from './check-util.mjs';

const QUERY_TYPES = ['all', 'plaintext', 'encrypted'];
const COMMON_NAMES = ['limit', 'cursor', 'includeValues', 'type', 'prefix', 'collection', 'startsWith', 'after',
  'before', 'reverse', 'since', 'until', 'where'];
const LIST_NAMES = new Set([...COMMON_NAMES, 'index', 'equals']);
const SEARCH_NAMES = new Set([...COMMON_NAMES, 'pattern']);
const WINDOW = ['since', 'until'];

// Epoch milliseconds, or ISO 8601 with Z or an offset (a zone-less time is refused).
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function timeMs(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : NaN;
  return typeof v === 'string' && ISO_TIME.test(v) ? Date.parse(v) : NaN;
}

const has = (o, name) => Object.hasOwn(o, name);
const any = (o, names) => names.some((name) => has(o, name));
const isMatcher = (v) => typeof v === 'string' && inRange(v.length, LIMITS.prefixPattern.min, LIMITS.prefixPattern.max);
const isIdBound = (v) => isNonEmptyString(v) && !v.includes(':') && utf8Bytes(v) <= LIMITS.idMaxBytes;
// With an index a bound is any scalar (a sortBy value or a key); in a collection it is an id.
const isRangeBound = (v, o) => (has(o, 'index') ? isScalar(v) : isIdBound(v));

const VALUE_RULES = {
  limit: (v) => isIntIn(v, LIMITS.listLimit),
  cursor: isNonEmptyString,
  includeValues: isBoolean,
  reverse: isBoolean,
  type: (v) => QUERY_TYPES.includes(v),
  prefix: isMatcher,
  pattern: isMatcher,
  collection: (v) => typeof v === 'string' && utf8Bytes(v) <= LIMITS.ledgerCollectionMaxBytes,
  startsWith: isIdBound,
  after: isRangeBound,
  before: isRangeBound,
  since: (v) => !Number.isNaN(timeMs(v)),
  until: (v) => !Number.isNaN(timeMs(v)),
  index: (v) => typeof v === 'string' && LIMITS.indexName.test(v),
  equals: (v) => isScalarMap(v, 0, LIMITS.equalsFields.max),
  where: (v) => isScalarMap(v, LIMITS.whereFields.min, LIMITS.whereFields.max),
};

const untilNotAfterSince = (o) => has(o, 'since') && has(o, 'until') && timeMs(o.until) <= timeMs(o.since);
const boundsOutOfOrder = (o) => has(o, 'collection') && has(o, 'after') && has(o, 'before')
  && byteCompare(o.after, o.before) >= 0;
const searchWithoutFilter = (o, search) => search && !any(o, ['prefix', 'pattern', 'where', 'collection'])
  && (o.type ?? 'all') === 'all';

// [problem text, (options, search) => true when the rule is broken]
const COMBINATION_RULES = [
  ['prefix cannot be combined with pattern, collection or index', (o) => has(o, 'prefix') && any(o, ['pattern', 'collection', 'index'])],
  ['pattern cannot be combined with collection', (o) => has(o, 'pattern') && has(o, 'collection')],
  ['collection cannot be combined with index', (o) => has(o, 'collection') && has(o, 'index')],
  ['startsWith needs collection', (o) => has(o, 'startsWith') && !has(o, 'collection')],
  ['startsWith cannot be combined with after or before', (o) => has(o, 'startsWith') && any(o, ['after', 'before'])],
  ['after, before and reverse need collection or index', (o) => any(o, ['after', 'before', 'reverse']) && !any(o, ['collection', 'index'])],
  ['since and until need collection', (o) => any(o, WINDOW) && !has(o, 'collection')],
  ['since and until cannot be combined with where, pattern, startsWith, after or before',
    (o) => any(o, WINDOW) && any(o, ['where', 'pattern', 'startsWith', 'after', 'before'])],
  ["since and until cannot be combined with type 'encrypted'", (o) => any(o, WINDOW) && o.type === 'encrypted'],
  ['until must be after since', untilNotAfterSince],
  ['equals needs index', (o) => has(o, 'equals') && !has(o, 'index')],
  ['where on list needs collection or index', (o, search) => !search && has(o, 'where') && !any(o, ['collection', 'index'])],
  ["where cannot be combined with type 'encrypted'", (o) => has(o, 'where') && o.type === 'encrypted'],
  ['after must sort before before', boundsOutOfOrder],
  ['search needs a prefix, pattern, where or type filter, or a collection', searchWithoutFilter],
];

// Undefined values are absent; a null cursor (the last page's cursor) is absent too.
function presentOptions(opts) {
  const isAbsent = ([name, value]) => value === undefined || (name === 'cursor' && value === null);
  return Object.fromEntries(Object.entries(opts).filter((entry) => !isAbsent(entry)));
}

function unknownProblem(o, search) {
  const allowed = search ? SEARCH_NAMES : LIST_NAMES;
  const unknown = Object.keys(o).find((name) => !allowed.has(name));
  return unknown === undefined ? null : `unknown ${search ? 'search' : 'list'} option: ${unknown}`;
}

function valueProblem(o) {
  const bad = Object.keys(o).find((name) => !VALUE_RULES[name](o[name], o));
  return bad === undefined ? null : `option ${bad} has an invalid value`;
}

function combinationProblem(o, search) {
  const rule = COMBINATION_RULES.find(([, broken]) => broken(o, search));
  return rule === undefined ? null : rule[0];
}

export function queryProblem(opts = {}, { search = false } = {}) {
  if (!isPlainObject(opts)) return 'query options must be a plain object';
  const o = presentOptions(opts);
  return unknownProblem(o, search) ?? valueProblem(o) ?? combinationProblem(o, search);
}
