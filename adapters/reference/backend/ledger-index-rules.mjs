// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The rules between indexes and ledgers, in both orders of declaration (ledgers page "Indexes"; subject contract v1).
// A ledger collection takes plain indexes only (LEDGER_INDEX_KIND); an index cannot use a personal field
// (INDEX_FIELD_ENCRYPTED); no index sorts by the subject field of a ledger that covers its collection (VALIDATION); an
// index on the subject field of a pseudonym ledger must lie within that ledger collection (LEDGER_INDEX_KIND), because
// that field holds tokens. Pure: each function returns [code, message] or null. The messages are the platform's.
import { patternsOverlap } from './ledger-defs.mjs';

export const SUBJECT_SORT_MESSAGE = 'An index cannot sort by the subject field of a ledger that covers its collection';

/** True when every collection the inner pattern covers is also covered by the outer pattern. */
export function patternWithin(inner, outer) {
  const [x, y] = [inner.split(':'), outer.split(':')];
  return x.length === y.length && y.every((segment, i) => segment === '*' || segment === x[i]);
}

const fieldsOf = (index) => [...index.fields, index.sortBy].filter((f) => f !== undefined);

function subjectIndexProblem(index, ledger) {
  if (index.sortBy !== undefined && index.sortBy === ledger.subjectField) return ['VALIDATION', SUBJECT_SORT_MESSAGE];
  const usesSubject = ledger.subjectField !== undefined && fieldsOf(index).includes(ledger.subjectField);
  if (ledger.subjectMode !== 'pseudonym' || !usesSubject || patternWithin(index.collection, ledger.collection)) return null;
  return ['LEDGER_INDEX_KIND', `Index ${index.name} uses the subject field of ledger ${ledger.name}; its collection must `
    + 'lie within that ledger collection'];
}

/** A new index against the ledgers (definitions, not FAILED) of the store. */
export function indexAgainstLedgers(index, ledgers) {
  for (const def of ledgers.filter((d) => patternsOverlap(d.collection, index.collection))) {
    if (index.unique || index.count) {
      return ['LEDGER_INDEX_KIND', `Ledger ${def.name} covers this collection; only plain indexes are allowed`];
    }
    if (fieldsOf(index).some((f) => def.personalFields.includes(f))) {
      return ['INDEX_FIELD_ENCRYPTED', `Ledger ${def.name} marks this field as personal; it cannot be indexed`];
    }
    const problem = subjectIndexProblem(index, def);
    if (problem !== null) return problem;
  }
  return null;
}

/** A new ledger (completed definition) against the indexes of the store. */
export function ledgerAgainstIndexes(ledger, indexes) {
  for (const index of indexes.filter((d) => patternsOverlap(d.collection, ledger.collection))) {
    if (index.unique || index.count) {
      return ['LEDGER_INDEX_KIND', `Index ${index.name} is unique or counted; ledger collections take plain indexes only`];
    }
    if (fieldsOf(index).some((f) => ledger.personalFields.includes(f))) {
      return ['INDEX_FIELD_ENCRYPTED', `Index ${index.name} uses a personal field`];
    }
    const problem = subjectIndexProblem(index, ledger);
    if (problem !== null) return problem;
  }
  return null;
}
