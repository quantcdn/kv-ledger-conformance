// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Secret values: AES-256-GCM with a key per backend (generated unless one is given). The sealed form is
// { iv, tag, data }, each base64. Nothing else in the backend sees the key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function createSealer(keyBase64) {
  const key = keyBase64 === undefined ? randomBytes(KEY_BYTES) : Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) throw new TypeError('the secret key must be 32 bytes, base64');
  return {
    keyBase64: key.toString('base64'),
    seal(text) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open({ iv, tag, data }) {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
