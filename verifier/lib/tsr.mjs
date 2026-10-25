// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// RFC 3161 token check with the Node standard library only: a small DER reader, the CMS signature of
// the token, the chain to a PINNED root (DigiCert Trusted Root G4) and the id-kp-timeStamping usage.
// Checked: (1) the signer certificate is matched by the issuer Name (DER) AND the serial of
// issuerAndSerialNumber, and its extendedKeyUsage extension is critical and holds only
// id-kp-timeStamping; (1b) with the pinned DigiCert root, the signer subject has O=DigiCert, Inc.;
// (2) it chains to a pinned root through CA certificates in the token, each valid at
// the token time (TSTInfo genTime), so an old archive still verifies after the certificates expire;
// (3) the signedAttrs, re-encoded as SET OF, verify with the signer key; (4) the contentType attribute
// is id-ct-TSTInfo and the messageDigest attribute equals the digest of the TSTInfo bytes.
// Not checked: the ESS signingCertificate attribute and revocation (no CRL or OCSP fetch).
import { createHash, verify, X509Certificate } from 'node:crypto';

const DIGICERT_TRUSTED_ROOT_G4 = `-----BEGIN CERTIFICATE-----
MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBi
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3Qg
RzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1MTIwMDAwWjBiMQswCQYDVQQGEwJV
UzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQu
Y29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0GCSqG
SIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3y
ithZwuEppz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1If
xp4VpX6+n6lXFllVcq9ok3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDV
ySAdYyktzuxeTsiT+CFhmzTrBcZe7FsavOvJz82sNEBfsXpm7nfISKhmV1efVFiO
DCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGYQJB5w3jHtrHEtWoYOAMQ
jdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6MUSaM0C/
CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCi
EhtmmnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADM
fRyVw4/3IbKyEbe7f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QY
uKZ3AeEPlAwhHbJUKSWJbOUOUlFHdL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXK
chYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8oR7FwI+isX4KJpn15GkvmB0t
9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIB
hjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQAD
ggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2
SV1EY+CtnJYYZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd
+SeuMIW59mdNOj6PWTkiU0TryF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWc
fFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy7zBZLq7gcfJW5GqXb5JQbZaNaHqa
sjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iahixTXTBmyUEFxPT9N
cCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN5r5N
0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie
4u1Ki7wb/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mI
r/OSmbaz5mEP0oUA51Aa5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1
/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tKG48BtieVU+i2iW1bvGjUI+iLUaJW+fCm
gKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP82Z+
-----END CERTIFICATE-----`;
export const PINNED_ROOT_FINGERPRINTS = ['55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88'];
export const PINNED_TSA_ROOTS = [new X509Certificate(DIGICERT_TRUSTED_ROOT_G4)];

const SEQ = 0x30, INT = 0x02, OCTETS = 0x04, OID = 0x06, NULL = 0x05, CTX0 = 0xa0, SET = 0x31, GENTIME = 0x18;
const hex = (s) => Buffer.from(s, 'hex');
const SHA256_OID = hex('0609608648016503040201');
const SIGNED_DATA_OID = hex('06092a864886f70d010702');
const TST_INFO_OID = hex('060b2a864886f70d0109100104');
const TS_EKU_BODY = '2b06010505070308'; // id-kp-timeStamping 1.3.6.1.5.5.7.3.8
const DIGICERT_ORG = 'DigiCert, Inc.';
const ATTR_CONTENT_TYPE = '06092a864886f70d010903', ATTR_MESSAGE_DIGEST = '06092a864886f70d010904';
const DIGESTS = { '0609608648016503040201': 'sha256', '0609608648016503040202': 'sha384', '0609608648016503040203': 'sha512' };
// rsaEncryption and sha256/384/512WithRSAEncryption (PKCS #1 v1.5), ecdsa-with-SHA256/384. RSA-PSS is refused.
const SIGNATURES = {
  '06092a864886f70d010101': 'rsa', '06092a864886f70d01010b': 'rsa', '06092a864886f70d01010c': 'rsa', '06092a864886f70d01010d': 'rsa',
  '06082a8648ce3d040302': 'ec', '06082a8648ce3d040303': 'ec',
};
const MAX_CHAIN = 5;

// One definite-length TLV at `at`, inside [at, limit). Indefinite lengths and lengths over 4 bytes are refused.
function readTlv(buf, at, limit) {
  if (at + 2 > limit) return undefined;
  const first = buf[at + 1];
  const count = first < 0x80 ? 0 : first & 0x7f;
  if (first === 0x80 || count > 4 || at + 2 + count > limit) return undefined;
  const len = count === 0 ? first : buf.readUIntBE(at + 2, count);
  const body = at + 2 + count;
  return body + len > limit ? undefined : { tag: buf[at], start: at, body, end: body + len };
}
function children(buf, t) {
  const out = [];
  for (let at = t.body; at < t.end;) {
    const c = readTlv(buf, at, t.end);
    if (!c) return undefined;
    out.push(c); at = c.end;
  }
  return out;
}
const bytes = (buf, t) => buf.subarray(t.body, t.end);
const isTag = (t, tag) => t?.tag === tag;
const equalsTlv = (buf, t, expected) => !!t && buf.subarray(t.start, t.end).equals(expected);
const kids = (buf, t, tag) => (isTag(t, tag) ? children(buf, t) : undefined);
const whole = (t, buf) => !!t && t.end === buf.length;

function responseParts(res) {
  const outer = readTlv(res, 0, res.length);
  return whole(outer, res) && isTag(outer, SEQ) ? children(res, outer) : undefined;
}
function explicit(buf, t) {
  const inner = isTag(t, CTX0) ? children(buf, t) : undefined;
  return inner?.length === 1 ? inner[0] : undefined;
}
// The children of SignedData { version, digestAlgorithms, encapContentInfo, certificates [0]?, crls [1]?, signerInfos }.
function signedDataParts(res) {
  const info = kids(res, responseParts(res)?.[1], SEQ);
  if (!info || info.length !== 2 || !equalsTlv(res, info[0], SIGNED_DATA_OID)) return undefined;
  return kids(res, explicit(res, info[1]), SEQ);
}
function tstInfoBytes(res) {
  const content = kids(res, signedDataParts(res)?.[2], SEQ);
  if (!content || !equalsTlv(res, content[0], TST_INFO_OID)) return undefined;
  const octets = explicit(res, content[1]);
  return isTag(octets, OCTETS) ? bytes(res, octets) : undefined;
}
function tstFields(res) {
  const tst = tstInfoBytes(res);
  if (!tst) return undefined;
  const top = readTlv(tst, 0, tst.length);
  const fields = whole(top, tst) ? kids(tst, top, SEQ) : undefined;
  return fields && isTag(fields[0], INT) && isTag(fields[1], OID) ? { tst, fields } : undefined;
}
const isNull = (t) => isTag(t, NULL) && t.end === t.body;
function sha256Imprint(buf, t) {
  const parts = kids(buf, t, SEQ);
  if (!parts || parts.length !== 2) return undefined;
  const alg = kids(buf, parts[0], SEQ);
  const algOk = !!alg && equalsTlv(buf, alg[0], SHA256_OID) && (alg.length === 1 || (alg.length === 2 && isNull(alg[1])));
  const h = parts[1];
  return algOk && isTag(h, OCTETS) && h.end - h.body === 32 ? Buffer.from(bytes(buf, h)) : undefined;
}

// True when the bytes are a structurally valid RFC 3161 TimeStampResp with a TSTInfo.
export const isRealToken = (res) => tstFields(res) !== undefined;

// The SHA-256 messageImprint of the token as hex, or undefined.
export function tokenImprintHex(res) {
  const f = tstFields(res);
  return f ? sha256Imprint(f.tst, f.fields[2])?.toString('hex') : undefined;
}

// TSTInfo genTime (field 4) in ms since the epoch.
function genTimeMs(res) {
  const f = tstFields(res);
  const t = f?.fields[4];
  const m = isTag(t, GENTIME) ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(f.tst.subarray(t.body, t.end).toString('ascii')) : null;
  if (!m) return refuse('the TSTInfo has no readable genTime');
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// serial, issuer Name (DER) and the extendedKeyUsage extension of a certificate, read from its DER.
function certInfo(cert) {
  const raw = cert.raw;
  const tbs = children(raw, readTlv(raw, 0, raw.length))[0];
  const items = children(raw, tbs);
  const at = isTag(items[0], CTX0) ? 1 : 0;
  const ext = items.find((t) => t.tag === 0xa3);
  return { serial: serialHex(bytes(raw, items[at]).toString('hex')), issuerDer: raw.subarray(items[at + 2].start, items[at + 2].end), eku: ekuOf(raw, ext) };
}
// { critical, oids } of the EKU extension (OID 2.5.29.37), or undefined when the certificate has none.
function ekuOf(raw, ext) {
  const list = ext ? children(raw, children(raw, ext)[0]) : [];
  for (const e of list) {
    const f = children(raw, e);
    if (hexOf(raw, f[0]) !== '0603551d25') continue;
    const critical = f.length === 3 && isTag(f[1], 0x01) && raw[f[1].body] !== 0;
    const inner = readTlv(raw, f[f.length - 1].body, f[f.length - 1].end);
    return { critical, oids: children(raw, inner).map((o) => bytes(raw, o).toString('hex')) };
  }
  return undefined;
}

const refuse = (why) => { throw new Error(`the token signature does not verify: ${why}`); };
const hexOf = (buf, t) => (t ? buf.subarray(t.start, t.end).toString('hex') : '');
const algOf = (buf, t) => hexOf(buf, kids(buf, t, SEQ)?.[0]);
const serialHex = (s) => s.toLowerCase().replace(/^0+/, '');
const validAt = (c, ms) => Date.parse(c.validFrom) <= ms && ms <= Date.parse(c.validTo);
const issuedBy = (c, issuer) => c.checkIssued(issuer) && c.verify(issuer.publicKey);

function certificates(buf, parts) {
  const set = parts.find((p) => p.tag === CTX0);
  const certs = set ? children(buf, set) : [];
  if (!certs) return refuse('the certificate set is malformed');
  return certs.filter((c) => c.tag === SEQ).map((c) => new X509Certificate(buf.subarray(c.start, c.end)));
}
// SignerInfo { version, sid issuerAndSerialNumber, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature }
function signerFields(buf, parts) {
  const infos = kids(buf, parts[parts.length - 1], SET);
  const f = infos?.length === 1 ? kids(buf, infos[0], SEQ) : undefined;
  const shaped = !!f && isTag(f[0], INT) && isTag(f[3], CTX0) && isTag(f[5], OCTETS);
  return shaped ? f : refuse('expected one signer with signed attributes');
}
function signerInfo(buf, parts) {
  const f = signerFields(buf, parts);
  const sid = kids(buf, f[1], SEQ);
  const serial = sid?.[1];
  const digest = DIGESTS[algOf(buf, f[2])], scheme = SIGNATURES[algOf(buf, f[4])];
  if (!isTag(serial, INT)) return refuse('the signer has no issuerAndSerialNumber');
  if (!digest || !scheme) return refuse('the digest or signature algorithm is not supported');
  if (!isTag(sid[0], SEQ)) return refuse('the signer has no issuer Name');
  return { serial: serialHex(bytes(buf, serial).toString('hex')), issuerDer: Buffer.from(buf.subarray(sid[0].start, sid[0].end)), digest, attrs: f[3], scheme, signature: Buffer.from(bytes(buf, f[5])) };
}
function attribute(buf, attrs, type) {
  for (const a of children(buf, attrs) ?? []) {
    const parts = kids(buf, a, SEQ);
    const values = parts && hexOf(buf, parts[0]) === type ? kids(buf, parts[1], SET) : undefined;
    if (values) return values.length === 1 ? values[0] : undefined;
  }
  return undefined;
}
function checkAttributes(buf, s, tst) {
  if (!equalsTlv(buf, attribute(buf, s.attrs, ATTR_CONTENT_TYPE), TST_INFO_OID)) refuse('the contentType attribute is not id-ct-TSTInfo');
  const md = attribute(buf, s.attrs, ATTR_MESSAGE_DIGEST);
  if (!isTag(md, OCTETS) || !bytes(buf, md).equals(createHash(s.digest).update(tst).digest())) refuse('the messageDigest attribute does not match the TSTInfo');
}
function checkSignature(buf, s, signer) {
  const signed = Buffer.concat([Buffer.from([SET]), buf.subarray(s.attrs.start + 1, s.attrs.end)]);
  const key = s.scheme === 'ec' ? { key: signer.publicKey, dsaEncoding: 'der' } : signer.publicKey;
  let ok = false;
  try { ok = verify(s.digest, signed, key, s.signature); } catch { ok = false; }
  if (!ok) refuse('the signed attributes do not verify with the signer key');
}
function findSigner(certs, s, signerOrg) {
  const signer = certs.find((c) => { const i = certInfo(c); return i.serial === s.serial && i.issuerDer.equals(s.issuerDer); });
  if (!signer) return refuse('the signer certificate is not in the token');
  const eku = certInfo(signer).eku;
  if (!eku?.critical || eku.oids.length !== 1 || eku.oids[0] !== TS_EKU_BODY) refuse('the signer certificate needs a critical extendedKeyUsage with only id-kp-timeStamping');
  if (signerOrg && !signer.subject.split('\n').includes(`O=${signerOrg.replace(/,/g, '\\,')}`)) refuse(`the signer subject is not O=${signerOrg}`);
  return signer;
}
const intermediateOk = (c) => { const eku = certInfo(c).eku; return !eku || eku.oids.includes(TS_EKU_BODY); };
function checkChain(signer, certs, roots, ms) {
  let cur = signer;
  for (let depth = 0; depth < MAX_CHAIN && validAt(cur, ms); depth++) {
    const root = roots.find((r) => issuedBy(cur, r));
    if (root) { if (validAt(root, ms)) return; break; }
    const next = certs.find((c) => c !== cur && c.ca && issuedBy(cur, c));
    if (!next) break;
    if (!intermediateOk(next)) refuse('an intermediate certificate has an EKU without id-kp-timeStamping');
    cur = next;
  }
  refuse('the signer does not chain to a pinned TSA root');
}

// Throws when the token is not signed by a certificate that chains to a pinned root.
// `nowMs` defaults to the genTime of the token; `roots` defaults to the pinned DigiCert root.
export function verifyTimestampToken(res, opts = {}) {
  const { roots = PINNED_TSA_ROOTS, nowMs } = opts;
  // The DigiCert organisation is required with the pinned root; custom roots (tests) may set `signerOrg`.
  const signerOrg = 'signerOrg' in opts ? opts.signerOrg : opts.roots ? undefined : DIGICERT_ORG;
  const parts = signedDataParts(res), tst = tstInfoBytes(res);
  if (!parts || !tst) return refuse('the token is malformed');
  const s = signerInfo(res, parts);
  const certs = certificates(res, parts);
  const signer = findSigner(certs, s, signerOrg);
  checkChain(signer, certs, roots, nowMs ?? genTimeMs(res));
  checkAttributes(res, s, tst);
  checkSignature(res, s, signer);
}
