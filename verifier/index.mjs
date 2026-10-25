// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// The offline verifier as a library (package export "./verifier"). The CLI is verify.mjs (bin kv-ledger-verify);
// importing this module runs nothing. See verifier/README.md for the inputs, the checks and the reasons.
export { verifyArchive, DIGEST_GRACE_MS } from './lib/verify.mjs';
export { verifyProof } from './lib/proof.mjs';
export { verifySigned, keysFromJson, entriesSha256, DOCUMENT_TYPES, PURGE_RECEIPT_TYPE, RECEIPT_MEANING } from './lib/signed.mjs';
export { purgeCheck } from './lib/purge.mjs';
export { verifyTimestampToken, PINNED_TSA_ROOTS } from './lib/tsr.mjs';
export { canonicalJson } from './lib/jcs.mjs';
export { sha256Hex, instanceName, genesisHash, entryHash, digestGenesisHash } from './lib/hash.mjs';
export { merkleRoot, auditPath, rootFromAuditPath } from './lib/merkle.mjs';
