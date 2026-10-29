// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The public key id of the ledger signing key. The public-key route names each key by its KMS key id (no account id or
// region). Digest signatures and documents signed before 2026-10-29 name the full KMS key ARN
// (arn:<partition>:kms:<region>:<account>:key/<key id>). Ids are compared by their public form, so an old ARN still
// finds the key that the route lists by key id, and the reverse.
const KMS_KEY_ARN = /^arn:[^:]+:kms:[^:]*:[^:]*:key\/(.+)$/;

/** The key id of a KMS key ARN; any other value unchanged. */
export const publicKeyId = (id) => KMS_KEY_ARN.exec(id)?.[1] ?? id;

/** The PEM in a { keyId: pem } map that names keyId: the exact own entry, else the entry with the same public key id. */
export function keyNamed(keys, keyId) {
  if (!keys || typeof keys !== 'object' || typeof keyId !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(keys, keyId)) return keys[keyId];
  const name = Object.keys(keys).find((k) => publicKeyId(k) === publicKeyId(keyId));
  return name === undefined ? undefined : keys[name];
}
