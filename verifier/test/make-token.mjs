// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// Builds an RFC 3161 TimeStampResp signed by the test TSA in fixtures/test-tsa (a test root, not for production).
import { X509Certificate, createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`../fixtures/test-tsa/${n}`, import.meta.url));
export const certDer = (n) => cert(n).raw;
export const TEST_ROOT_PEM = fx('root.crt').toString('utf8');
const cert = (n) => new X509Certificate(fx(n + '.crt'));
// signer name -> the intermediate certificates that go into the token with it
const CHAINS = { 'signer-under-bad': ['bad-intermediate'], 'signer-under-plain': ['plain-intermediate'] };
const hex = (s) => Buffer.from(s, 'hex');

function tlv(tag, body) {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p) => tlv(0x30, Buffer.concat(p));
const SHA256_ALG = hex('300d0609608648016503040201' + '0500');
const RSA_ALG = hex('300d06092a864886f70d0101010500');

// The issuer Name (DER) of the signer certificate: field after the signature algorithm in the TBS.
export function issuerDer(cert) {
  const read = (buf, at) => {
    const first = buf[at + 1], count = first < 0x80 ? 0 : first & 0x7f;
    const len = count === 0 ? first : buf.readUIntBE(at + 2, count);
    return { start: at, body: at + 2 + count, end: at + 2 + count + len };
  };
  const top = read(cert.raw, 0), tbs = read(cert.raw, top.body);
  const items = [];
  for (let at = tbs.body; at < tbs.end;) { const t = read(cert.raw, at); items.push(t); at = t.end; }
  const issuer = items[cert.raw[items[0].start] === 0xa0 ? 3 : 2];
  return cert.raw.subarray(issuer.start, issuer.end);
}
export function serialDer(cert) {
  let b = Buffer.from(cert.serialNumber, 'hex');
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

// options: genTime, signer (fixture name), extraCerts (DER buffers added to the token), sid ({ issuerDer, serialDer } override)
export function makeToken(imprintHex, { genTime = '20261016060000Z', signer = 'signer', extraCerts = [], sid } = {}) {
  const signerCert = cert(signer), signerKey = createPrivateKey(fx(signer + '.key'));
  const certs = [signerCert.raw, ...(CHAINS[signer] ?? []).map((n) => cert(n).raw), ...extraCerts];
  const tst = seq(hex('020101'), hex('0603' + '2a0304'), seq(SHA256_ALG, tlv(0x04, hex(imprintHex))), hex('020101'), tlv(0x18, Buffer.from(genTime, 'ascii')));
  const attrs = Buffer.concat([
    seq(hex('06092a864886f70d010903'), tlv(0x31, hex('060b2a864886f70d0109100104'))),
    seq(hex('06092a864886f70d010904'), tlv(0x31, tlv(0x04, createHash('sha256').update(tst).digest()))),
  ]);
  const signature = sign('sha256', tlv(0x31, attrs), signerKey);
  const info = seq(hex('020101'), seq(sid?.issuerDer ?? issuerDer(signerCert), sid?.serialDer ?? serialDer(signerCert)), SHA256_ALG, tlv(0xa0, attrs), RSA_ALG, tlv(0x04, signature));
  const signed = seq(hex('020103'), tlv(0x31, SHA256_ALG), seq(hex('060b2a864886f70d0109100104'), tlv(0xa0, tlv(0x04, tst))), tlv(0xa0, Buffer.concat(certs)), tlv(0x31, info));
  return seq(seq(hex('020100')), seq(hex('06092a864886f70d010702'), tlv(0xa0, signed)));
}
