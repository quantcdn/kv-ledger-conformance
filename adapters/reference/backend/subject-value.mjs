// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The subject field of a ledger entry (subject contract version 1), as the platform stores and reads it. Pure.
// Stored form: pseudonym mode stores the subject token in the subject field and the value as appended, sealed, in
// $subject (AAD .../<id>/$subject). Clear mode keeps the field as given and stores the token in $subjectTag. Personal
// fields are sealed with the subject key in both modes.
// Read (decrypted): the personal fields are opened; pseudonym mode shows the opened $subject in the subject field and
// leaves $subject out. With no key (shredded), each of them reads { $shredded: true }.
// Read (sealed): $subject is left out and the sealed personal fields read '[PERSONAL]'; nothing is opened.
import { isSubjectToken } from './subject-keys.mjs';
import { openField, sealField } from './ledger-seal.mjs';

export const SUBJECT_ECHO = '$subject';
export const SUBJECT_TAG = '$subjectTag';
export const RESERVED_SUBJECT_FIELDS = Object.freeze([SUBJECT_ECHO, SUBJECT_TAG]);
export const LEDGER_FORMAT_RETIRED_MESSAGE = 'This ledger uses a retired subject format; declare a new ledger';
const SHREDDED = Object.freeze({ $shredded: true });
const PERSONAL_TEXT = '[PERSONAL]';

const has = (o, name) => Object.hasOwn(o, name);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 'pseudonym' | 'clear' for a ledger with a subject field, else undefined. */
export const subjectModeOf = (def) => (def.subjectField === undefined ? undefined : def.subjectMode);
/** A definition with a subject field and no subjectMode: the retired format (made before subject-v1). */
export const isRetiredFormat = (def) => def.subjectField !== undefined && def.subjectMode === undefined;

/** True for the sealed { $enc, iv, tag } shape. */
export const isSealed = (v) => isRecord(v) && typeof v.$enc === 'string' && typeof v.iv === 'string'
  && typeof v.tag === 'string';

/** The subject token an entry stores (pseudonym: the subject field; clear: $subjectTag), or undefined. */
export function tokenOf(def, value) {
  const mode = subjectModeOf(def);
  if (mode === undefined || !isRecord(value)) return undefined;
  const stored = mode === 'pseudonym' ? value[def.subjectField] : value[SUBJECT_TAG];
  return isSubjectToken(stored) ? stored : undefined;
}

const seal = (plain, key, aad) => sealField({ key, aad, plaintext: JSON.stringify(plain) });
const open = (sealed, key, aad) => JSON.parse(openField({ key, aad, envelope: sealed }));

/** The value as stored: the subject transform, then the personal fields sealed. w: { key (Buffer), token }. */
export function storedSubjectValue(def, value, w, aad) {
  const field = def.subjectField;
  const out = subjectModeOf(def) === 'pseudonym'
    ? { ...value, [field]: w.token, [SUBJECT_ECHO]: seal(value[field], w.key, aad(SUBJECT_ECHO)) }
    : { ...value, [SUBJECT_TAG]: w.token };
  for (const f of def.personalFields) if (has(value, f)) out[f] = seal(value[f], w.key, aad(f));
  return out;
}

/** True when the stored value has a sealed personal field or a sealed $subject. */
export const hasSealed = (value, def) => isRecord(value)
  && [...def.personalFields, SUBJECT_ECHO].some((f) => isSealed(value[f]));

const withoutEcho = (value) => {
  const out = { ...value };
  delete out[SUBJECT_ECHO];
  return out;
};

/** The decrypted view of a stored value. key: a Buffer (live) or null (shredded). opener(sealed, field) opens. */
export function openedValue(def, value, key, opener) {
  const out = { ...value };
  for (const f of def.personalFields.filter((name) => has(value, name) && isSealed(value[name]))) {
    out[f] = key ? opener(value[f], f) : { ...SHREDDED };
  }
  if (subjectModeOf(def) !== 'pseudonym' || !isSealed(value[SUBJECT_ECHO])) return out;
  out[def.subjectField] = key ? opener(value[SUBJECT_ECHO], SUBJECT_ECHO) : { ...SHREDDED };
  return withoutEcho(out);
}

/** The sealed view: $subject left out, the sealed personal fields '[PERSONAL]'. Returns { value, personal }. */
export function sealedValue(def, value) {
  if (!isRecord(value)) return { value, personal: [] };
  const out = withoutEcho(value);
  const personal = (def?.personalFields ?? []).filter((f) => isSealed(value[f]));
  for (const f of personal) out[f] = PERSONAL_TEXT;
  return { value: out, personal };
}

export { open as openSealed };
