// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Personal fields of a ledger entry (ledgers page "Personal Fields and Shredding" and "Byte Layout"): AES-256-GCM
// under the subject's key, a 12-byte IV, a 16-byte tag, and the additional authenticated data
// `<org>/<store>/<collection>/<id>/<field>`. The sealed form is { $enc, iv, tag } in that order, each base64.
// The plaintext is the JSON text of the field value.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export const newSubjectKey = () => randomBytes(KEY_BYTES).toString('base64');
export const fieldAad = ({ org, store, collection, id, field }) => `${org}/${store}/${collection}/${id}/${field}`;

/** True for an object that holds a `$enc` or `$shredded` key (a sealed or shredded field). */
export const isSealedShape = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.hasOwn(v, '$enc') || Object.hasOwn(v, '$shredded'));

/** Seals plaintext (text) with key (32 bytes) and iv (12 bytes; random when absent). */
export function sealField({ key, iv = randomBytes(IV_BYTES), aad, plaintext }) {
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { $enc: data.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Opens an envelope. Throws when the key, the aad or the bytes do not match. */
export function openField({ key, aad, envelope }) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.$enc, 'base64')), decipher.final()]).toString('utf8');
}
