// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The canonical form of a ledger subject id (subject contract version 1; fixtures/subject-v1-vectors.json). The server
// canonicalises the id; a client never does. Pure: the caller passes `invalid(message)`, which returns the error to
// throw. The messages are the platform's, and they never echo the id.
import { LIMITS } from '../../../lib/limits.mjs';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const SUBJECT_CASES = Object.freeze(['exact', 'fold']);

function asText(raw, field, invalid) {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return String(raw);
  throw invalid(`${field} must be a string or a safe integer`);
}

function shape(text, subjectCase) {
  const trimmed = text.replace(EDGE_WHITE_SPACE, '').normalize('NFC');
  return subjectCase === 'fold' ? trimmed.toLowerCase().normalize('NFC') : trimmed;
}

const isBad = (out) => out === '' || CONTROL.test(out)
  || Buffer.byteLength(out, 'utf8') > LIMITS.ledgerSubjectMaxBytes;

/** The canonical subject id: a string or a safe integer, trimmed, NFC, folded with subjectCase 'fold'. */
export function canonicalSubjectId(raw, subjectCase, field, invalid) {
  const text = asText(raw, field, invalid);
  const bad = () => invalid(`${field} must be 1 to ${LIMITS.ledgerSubjectMaxBytes} bytes (UTF-8) of well-formed text `
    + 'without control characters');
  if (LONE_SURROGATE.test(text)) throw bad();
  const out = shape(text, subjectCase);
  if (isBad(out)) throw bad();
  return out;
}
