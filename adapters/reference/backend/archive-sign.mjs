// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The local P-256 signing key of the simulated archive (spec 9.1; ledgers page "Signature"). Not a platform key:
// it lives in memory and in the backend snapshot. The signature is ECDSA P-256, DER, base64, over the SHA-256 of
// the JCS bytes of the digest.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '../../../lib/ledger-bytes.mjs';

export const LOCAL_KEY_ID = 'local-reference-key';

/** createSigner(privatePem?): { keyId, privatePem, publicKeyPem, sign(digest) -> base64 DER }. */
export function createSigner(privatePem) {
  const privateKey = privatePem === undefined
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
    : createPrivateKey(privatePem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return {
    keyId: LOCAL_KEY_ID,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem,
    sign: (digest) => sign('sha256', Buffer.from(canonicalJson(digest), 'utf8'),
      { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}
