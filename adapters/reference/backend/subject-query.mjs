// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Lists that name a subject (subject contract v1), as the platform reads them. A read never makes a key.
// - equals on the subject field of an index that lies within a pseudonym ledger: the id becomes the subject's live
//   token (the field holds tokens). A shredded, absent or non-canonical subject gives an empty page.
// - where with the subject field of a ledger (either mode): that ledger's rows match the field by token (pseudonym:
//   the field; clear: $subjectTag) and the other fields by value; other rows match by value.
import { patternWithin } from './ledger-index-rules.mjs';
import { canonicalSubjectId } from './subject-canonical.mjs';
import { subjectModeOf, tokenOf } from './subject-value.mjs';

const has = (o, name) => Object.hasOwn(o, name);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function createSubjectQuery(core, { ledgers, subjects }) {
  const validation = (message) => core.error('VALIDATION', message);
  const liveDefinitions = (store) => [...store.ledgers.values()].map((e) => ledgers.refreshed(store, e))
    .filter((e) => e.state !== 'FAILED').map((e) => e.definition);

  /** The live token of the subject value in ledger def, or undefined. */
  function liveToken(store, def, raw) {
    let canonicalId;
    try {
      canonicalId = canonicalSubjectId(raw, def.subjectCase, def.subjectField, validation);
    } catch {
      return undefined;
    }
    const found = subjects.findSubject(store, def.name, canonicalId);
    return found?.state.state === 'live' ? found.state.token : undefined;
  }

  /** The options of a list by index with the subject id as its token, or 'empty'. index: the index definition. */
  function rewriteEquals(store, o, index) {
    const def = liveDefinitions(store).find((d) => subjectModeOf(d) === 'pseudonym'
      && index.fields.includes(d.subjectField) && patternWithin(index.collection, d.collection));
    if (def === undefined || !isRecord(o.equals) || !has(o.equals, def.subjectField)) return o;
    const token = liveToken(store, def, o.equals[def.subjectField]);
    return token === undefined ? 'empty' : { ...o, equals: { ...o.equals, [def.subjectField]: token } };
  }

  /** (key, record, value) -> true when the row matches `where`; fieldsMatch(value, where) tests plain fields. */
  function whereMatcher(store, where, fieldsMatch) {
    const defs = liveDefinitions(store).filter((d) => subjectModeOf(d) !== undefined && has(where, d.subjectField));
    const tokens = new Map(defs.map((d) => [d.name, { def: d, token: liveToken(store, d, where[d.subjectField]) }]));
    return (record, value) => {
      const hit = record.ledger === undefined ? undefined : tokens.get(record.ledger.name);
      if (hit === undefined) return fieldsMatch(value, where);
      const rest = Object.fromEntries(Object.entries(where).filter(([f]) => f !== hit.def.subjectField));
      return hit.token !== undefined && tokenOf(hit.def, value) === hit.token && fieldsMatch(value, rest);
    };
  }

  return { rewriteEquals, whereMatcher };
}
