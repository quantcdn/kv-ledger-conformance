// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// append (ledgers page "Append and Read", "Provenance", "Personal Fields", "Byte Layout"; spec 9.1).
// Order: the covering ledger (LEDGER_NOT_FOUND), an idempotency replay, the ledger state (LEDGER_DROPPED,
// LEDGER_NOT_READY), reserved fields, then the write under any injected 'append' fault: shard, id, sealing of
// personal fields, the stored envelope and its size, the hash chain, the receipt and the idempotency record.
// options: { idempotencyKey, auto } (auto: the edge generated the key, so an unknown outcome is not retryable).
import { LIMITS } from '../../../lib/limits.mjs';
import { utf8Bytes } from '../../../lib/check-util.mjs';
import { canonicalJson, entryHash, genesisHash, instanceName } from '../../../lib/ledger-bytes.mjs';
import { nextId, nextRandom, shardName } from './ledger-ids.mjs';
import { fieldAad, isSealedShape, newSubjectKey, sealField } from './ledger-seal.mjs';

const RESERVED = ['at', '$event', '$subject', '$subjectTag'];

const reservedField = (value) => Object.keys(value)
  .find((name) => RESERVED.includes(name) || isSealedShape(value[name]));

const isSubject = (v) => typeof v === 'string' && v.length > 0 && utf8Bytes(v) <= LIMITS.ledgerSubjectMaxBytes;

const copyReceipt = (receipt) => ({ ...receipt, source: { ...receipt.source } });

export function createAppend(core, ledgers, faults) {
  const source = () => ({ type: 'edge', principal: `${core.org}/local/reference` });

  function replayOf(store, idempotencyKey, fingerprint) {
    const prior = idempotencyKey === undefined ? undefined : store.idempotency.get(idempotencyKey);
    if (prior === undefined || core.now() - prior.at > LIMITS.idempotencyKey.replayWindowMs) return null;
    if (prior.kind !== 'append' || prior.fingerprint !== fingerprint) {
      throw core.error('VALIDATION', 'the idempotencyKey was used for a different entry', { idempotencyKey });
    }
    return { ...copyReceipt(prior.receipt), replayed: true };
  }

  const STATE_ERRORS = {
    DROPPED: (entry) => core.error('LEDGER_DROPPED', `ledger ${entry.definition.name} was dropped`,
      { ledger: entry.definition.name }),
    PENDING: (entry) => core.error('LEDGER_NOT_READY', `ledger ${entry.definition.name} is not active yet`,
      { ledger: entry.definition.name, state: 'PENDING', activeAfter: ledgers.iso(entry.activeAfterMs) }),
  };

  function checkAppendable(entry, value) {
    const stateError = STATE_ERRORS[entry.state];
    if (stateError) throw stateError(entry);
    const reserved = reservedField(value);
    if (reserved !== undefined) throw core.error('VALIDATION', `${reserved} is a reserved field or value`);
  }

  function chooseShard(chains) {
    const [fraction, state] = nextRandom(core.rngState);
    core.rngState = state;
    return shardName(Math.floor(fraction * chains));
  }

  function subjectKeyOf(store, ledger, subject) {
    const id = `${ledger}\n${subject}`;
    if (!store.subjectKeys.has(id)) store.subjectKeys.set(id, newSubjectKey());
    return { id, key: Buffer.from(store.subjectKeys.get(id), 'base64') };
  }

  // { value (personal fields sealed), personal (names), subjectKeyId }.
  function sealPersonal(store, definition, collection, id, value) {
    const personal = definition.personalFields.filter((field) => Object.hasOwn(value, field));
    if (personal.length === 0) return { value, personal };
    const subject = value[definition.subjectField];
    if (!isSubject(subject)) throw core.error('LEDGER_SUBJECT_REQUIRED', 'the entry has personal fields and no subject');
    const { id: subjectKeyId, key } = subjectKeyOf(store, definition.name, subject);
    const sealed = { ...value };
    for (const field of personal) {
      const aad = fieldAad({ org: core.org, store: store.id, collection, id, field });
      sealed[field] = sealField({ key, aad, plaintext: JSON.stringify(value[field]) });
    }
    return { value: sealed, personal, subjectKeyId };
  }

  function storedEnvelope(value, entrySource) {
    const stored = JSON.stringify({ type: 'plaintext', value, source: entrySource });
    if (utf8Bytes(stored) > LIMITS.ledgerValueMaxBytes) {
      throw core.error('LIMIT_EXCEEDED', 'the stored value is over the ledger value limit', { status: 400 });
    }
    return stored;
  }

  // The chain link of a new entry on a shard: { chainId, chain, id, at, random, seq, prevHash, instance }.
  function nextLink(store, entry, collection) {
    const shard = chooseShard(entry.definition.chains);
    const chainId = `${collection}#${shard}`;
    const chain = store.chains.get(chainId);
    const instance = instanceName(core.org, store.id, collection, shard);
    const ids = nextId(core.now(), chain ?? null, shard);
    const prevHash = chain ? chain.hash : genesisHash(instance, entry.definitionHash);
    return { shard, chainId, chain, instance, ...ids, seq: (chain?.seq ?? 0) + 1, prevHash };
  }

  function write(store, entry, collection, value) {
    const name = entry.definition.name;
    const link = nextLink(store, entry, collection);
    const sealed = sealPersonal(store, entry.definition, collection, link.id, value);
    const entrySource = source();
    const stored = storedEnvelope(sealed.value, entrySource);
    const { shard, id, at, seq, prevHash } = link;
    const hash = entryHash({ prevHash, instance: link.instance, seq, id, at, stored });
    const key = `${collection}:${id}`;
    store.items.set(key, { raw: JSON.stringify(sealed.value), stored, encrypted: false, createdAt: at, updatedAt: at,
      expiresAt: null, personal: sealed.personal, subjectKeyId: sealed.subjectKeyId,
      ledger: { name, collection, id, shard, seq, at, hash, prevHash, source: entrySource } });
    const keys = link.chain ? link.chain.keys : [];
    keys.push(key);
    store.chains.set(link.chainId, { ledger: name, collection, shard, seq, hash, at, random: link.random, keys });
    return { key, id, shard, seq, at, hash, prevHash, ledger: name, source: entrySource };
  }

  function append(storeId, collection, value, { idempotencyKey, auto = false } = {}) {
    const store = core.needStore(storeId);
    const entry = ledgers.covering(store, collection);
    if (entry === undefined) throw core.error('LEDGER_NOT_FOUND', `no ledger covers ${collection}`);
    const fingerprint = canonicalJson([collection, value]);
    const replay = replayOf(store, idempotencyKey, fingerprint);
    if (replay !== null) return replay;
    checkAppendable(entry, value);
    const details = idempotencyKey === undefined ? {} : { idempotencyKey };
    const retryable = idempotencyKey !== undefined && !auto;
    return faults.run('append', { retryable, retryableBefore: true, details }, () => {
      const receipt = write(store, entry, collection, value);
      if (idempotencyKey !== undefined) {
        store.idempotency.set(idempotencyKey, { kind: 'append', fingerprint, receipt, at: core.now() });
      }
      return copyReceipt(receipt);
    });
  }

  return { append };
}
