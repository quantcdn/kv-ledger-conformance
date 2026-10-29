// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Ledger definitions (ledgers page "Declare a Ledger" and "Definition Hash"): the rules, and the completed
// definition { v: 1, name, collection, chains, retentionDays, lockMode, personalFields, subjectField?, anchor,
// createdAt } plus, with a subjectField, subjectMode ('pseudonym' by default) and subjectCase ('exact' by default)
// (subject contract version 1). Pure functions: nothing here touches the store.
import { LIMITS } from '../../../lib/limits.mjs';
import { isIntIn, isPlainObject, utf8Bytes } from '../../../lib/check-util.mjs';

const KNOWN = new Set(['name', 'collection', 'chains', 'retentionDays', 'lockMode', 'personalFields', 'subjectField',
  'anchor', 'subjectMode', 'subjectCase']);
// The subject options, their values and defaults (the platform's).
const SUBJECT_OPTIONS = ['subjectMode', 'subjectCase'];
const SUBJECT_VALUES = { subjectMode: ['pseudonym', 'clear'], subjectCase: ['exact', 'fold'] };
const SUBJECT_DEFAULTS = { subjectMode: 'pseudonym', subjectCase: 'exact' };
const LOCK_MODES = ['governance', 'compliance'];
const ANCHOR_TYPES = ['none', 'customer-bucket', 'rfc3161'];

const isFieldName = (v) => typeof v === 'string' && LIMITS.fieldName.test(v) && !LIMITS.reservedFieldNames.includes(v);
const isPattern = (v) => typeof v === 'string' && v.length > 0 && v.split(':').every((segment) => segment.length > 0)
  && utf8Bytes(v) <= LIMITS.ledgerCollectionMaxBytes;
const isPersonalList = (v) => v === undefined || (Array.isArray(v) && v.length <= LIMITS.ledgerPersonalFieldsMax
  && v.every((f) => isFieldName(f) && f !== 'at') && new Set(v).size === v.length);
const isAnchor = (v) => v === undefined || (isPlainObject(v) && ANCHOR_TYPES.includes(v.type));
const personalOf = (d) => (Array.isArray(d.personalFields) ? d.personalFields : []);

// [problem, (def) => true when the rule is broken]
const RULES = [
  ['unknown ledger property', (d) => Object.keys(d).some((name) => !KNOWN.has(name))],
  ['invalid ledger name', (d) => typeof d.name !== 'string' || !LIMITS.ledgerName.test(d.name)],
  ['collection must be a pattern of non-empty segments within the byte limit', (d) => !isPattern(d.collection)],
  ['chains is out of range', (d) => !isIntIn(d.chains, LIMITS.ledgerChains)],
  ['retentionDays is out of range', (d) => !isIntIn(d.retentionDays, LIMITS.ledgerRetentionDays)],
  ['lockMode must be governance or compliance', (d) => d.lockMode !== undefined && !LOCK_MODES.includes(d.lockMode)],
  ['personalFields must be distinct field names other than at', (d) => !isPersonalList(d.personalFields)],
  ['invalid subjectField', (d) => d.subjectField !== undefined && !isFieldName(d.subjectField)],
  ['subjectField cannot be a personal field', (d) => personalOf(d).includes(d.subjectField)],
  ['invalid anchor', (d) => !isAnchor(d.anchor)],
];

/** The problem text of a definition, or null. */
export function ledgerDefinitionProblem(def) {
  if (!isPlainObject(def)) return 'the ledger definition must be an object';
  const rule = RULES.find(([, broken]) => broken(def));
  return rule === undefined ? null : rule[0];
}

/** The problem text of the subject options (the platform's), or null. */
export function subjectOptionProblem(def) {
  for (const key of SUBJECT_OPTIONS.filter((name) => def[name] !== undefined)) {
    if (def.subjectField === undefined) return `${key} needs a subjectField`;
    if (!SUBJECT_VALUES[key].includes(def[key])) return `${key} must be one of: ${SUBJECT_VALUES[key].join(', ')}`;
  }
  return null;
}

/** Personal fields without a subject field (LEDGER_SUBJECT_REQUIRED). */
export const needsSubject = (def) => personalOf(def).length > 0 && def.subjectField === undefined;

/** The completed definition, with createdAt as ISO text. */
export function completeDefinition(def, createdAtMs) {
  const out = {
    v: 1,
    name: def.name,
    collection: def.collection,
    chains: def.chains,
    retentionDays: def.retentionDays,
    lockMode: def.lockMode ?? 'governance',
    personalFields: [...personalOf(def)],
  };
  if (def.subjectField !== undefined) {
    out.subjectField = def.subjectField;
    for (const key of SUBJECT_OPTIONS) out[key] = def[key] ?? SUBJECT_DEFAULTS[key];
  }
  out.anchor = def.anchor === undefined ? { type: 'none' } : { ...def.anchor };
  out.createdAt = new Date(createdAtMs).toISOString();
  return out;
}

/** True when two collection patterns can cover one concrete collection. */
export function patternsOverlap(a, b) {
  const [x, y] = [a.split(':'), b.split(':')];
  return x.length === y.length && x.every((segment, i) => segment === '*' || y[i] === '*' || segment === y[i]);
}
