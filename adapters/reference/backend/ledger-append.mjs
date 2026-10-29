// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 QuantCDN Pty Ltd
// append (ledgers page "Append and Read", "Provenance", "Personal Fields", "Byte Layout"; subject contract v1; spec 9.1).
// Order: the covering ledger (LEDGER_NOT_FOUND), the retired subject format (LEDGER_FORMAT_RETIRED), an idempotency
// key used before its subject was erased, an idempotency replay, the ledger state (LEDGER_DROPPED, LEDGER_NOT_READY),
// reserved fields, the subject id (VALIDATION, LEDGER_SUBJECT_REQUIRED), then the write under any injected 'append'
// fault: shard, id, the subject listing and key, the stored value (subject-value.mjs), the stored envelope and its
// size, the hash chain, the receipt and the idempotency record (with the subject key generation as `kid`).
// options: { idempotencyKey, auto } (auto: the edge generated the key, so an unknown outcome is not retryable).
// appendShredEntry: the shred entry of an erasure, never sealed, from the platform source quant-ledger.
import { LIMITS } from '../../../lib/limits.mjs';
import { utf8Bytes } from '../../../lib/check-util.mjs';
import { canonicalJson, entryHash, genesisHash, instanceName } from '../../../lib/ledger-bytes.mjs';
import { nextId, nextRandom, shardName } from './ledger-ids.mjs';
import { fieldAad, isSealedShape } from './ledger-seal.mjs';
import { canonicalSubjectId } from './subject-canonical.mjs';
import {
  isRetiredFormat, isSealed, LEDGER_FORMAT_RETIRED_MESSAGE, RESERVED_SUBJECT_FIELDS, storedSubjectValue,
} from './subject-value.mjs';

export const ERASED_KEY_MESSAGE = 'This idempotency key was used before the subject was erased; use a new key.';
export const LEDGER_SERVICE = 'quant-ledger';

const has = (o, name) => Object.hasOwn(o, name);
const sealedOutside = (v, def) => Object.keys(v).find((f) => !def.personalFields.includes(f) && isSealed(v[f]));

// [the value breaks the rule, message] (the platform's order and texts).
const VALUE_RULES = [
  [(v, def) => sealedOutside(v, def) !== undefined,
    (v, def) => `Field ${sealedOutside(v, def)} has the reserved {$enc, iv, tag} shape`],
  [(v) => has(v, 'at'), () => '"at" is reserved in ledger entries: the server sets it'],
  [(v) => has(v, '$event'), () => '"$event" is reserved for shred entries'],
  [(v) => RESERVED_SUBJECT_FIELDS.some((f) => has(v, f)), () => '"$subject" and "$subjectTag" are reserved in ledger entries'],
  [(v) => Object.values(v).some(isSealedShape), () => 'Field values must not use the reserved $enc or $shredded shapes'],
];

const copyReceipt = (receipt) => ({ ...receipt, source: { ...receipt.source } });

export function createAppend(core, ledgers, faults, subjects) {
  const edgeSource = () => ({ type: 'edge', principal: `${core.org}/local/reference` });
  const invalid = (message) => core.error('VALIDATION', message);

  /** The canonical subject id of the value; undefined when it has no subject field. */
  function canonicalIdOf(def, value) {
    const field = def.subjectField;
    if (field === undefined || !has(value, field)) {
      if (def.personalFields.some((f) => has(value, f))) {
        throw core.error('LEDGER_SUBJECT_REQUIRED', `${field ?? 'subjectField'} is required when a personal field is present`);
      }
      return undefined;
    }
    return canonicalSubjectId(value[field], def.subjectCase, field, invalid);
  }

  // A live record of this key with a subject key generation, while that generation is not live: refuse.
  function refuseErasedKey(store, def, value, idempotencyKey) {
    const prior = idempotencyKey === undefined ? undefined : store.idempotency.get(idempotencyKey);
    if (typeof prior?.kid !== 'string' || core.now() - prior.at > LIMITS.idempotencyKey.replayWindowMs) return;
    const canonicalId = canonicalIdOf(def, value);
    const found = canonicalId === undefined ? undefined : subjects.findSubject(store, def.name, canonicalId);
    if (found?.state.state !== 'live' || found.state.gen !== prior.kid) throw invalid(ERASED_KEY_MESSAGE);
  }

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
    const broken = VALUE_RULES.find(([breaks]) => breaks(value, entry.definition));
    if (broken !== undefined) throw invalid(broken[1](value, entry.definition));
  }

  function chooseShard(chains) {
    const [fraction, state] = nextRandom(core.rngState);
    core.rngState = state;
    return shardName(Math.floor(fraction * chains));
  }

  // (id) -> the stored value of the entry: { value, personal (sealed names), kid (the subject key generation) }.
  // The subject is listed first, then gets its live key and token (CONTENTION just after a shred).
  function sealerFor(store, def, collection, value, canonicalId) {
    if (canonicalId === undefined) return () => ({ value, personal: [] });
    const { ref } = subjects.findSubject(store, def.name, canonicalId, { create: true });
    subjects.addListing(store, def.name, ref, collection);
    const w = subjects.keyForWrite(store, def.name, ref);
    const personal = def.personalFields.filter((f) => has(value, f));
    return (id) => {
      const aad = (field) => fieldAad({ org: core.org, store: store.id, collection, id, field });
      return { value: storedSubjectValue(def, value, w, aad), personal, kid: w.gen };
    };
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

  // sealing(id) -> { value, personal, kid? }: the stored value of the entry with that id.
  function write(store, entry, collection, { sealing, source }) {
    const name = entry.definition.name;
    const link = nextLink(store, entry, collection);
    const sealed = sealing(link.id);
    const stored = storedEnvelope(sealed.value, source);
    const { shard, id, at, seq, prevHash } = link;
    const hash = entryHash({ prevHash, instance: link.instance, seq, id, at, stored });
    const key = `${collection}:${id}`;
    store.items.set(key, { raw: JSON.stringify(sealed.value), stored, encrypted: false, createdAt: at, updatedAt: at,
      expiresAt: null, personal: sealed.personal, ledger: { name, collection, id, shard, seq, at, hash, prevHash, source } });
    const keys = link.chain ? link.chain.keys : [];
    keys.push(key);
    store.chains.set(link.chainId, { ledger: name, collection, shard, seq, hash, at, random: link.random, keys });
    return { receipt: { key, id, shard, seq, at, hash, prevHash, ledger: name, source }, kid: sealed.kid };
  }

  function coveringOf(store, collection) {
    const entry = ledgers.covering(store, collection);
    if (entry === undefined) throw core.error('LEDGER_NOT_FOUND', `no ledger covers ${collection}`);
    if (isRetiredFormat(entry.definition)) throw core.error('LEDGER_FORMAT_RETIRED', LEDGER_FORMAT_RETIRED_MESSAGE);
    return entry;
  }

  function remember(store, idempotencyKey, fingerprint, written) {
    if (idempotencyKey === undefined) return;
    const kid = written.kid === undefined ? {} : { kid: written.kid };
    store.idempotency.set(idempotencyKey, { kind: 'append', fingerprint, receipt: written.receipt, at: core.now(), ...kid });
  }

  function append(storeId, collection, value, { idempotencyKey, auto = false } = {}) {
    const store = core.needStore(storeId);
    const entry = coveringOf(store, collection);
    const def = entry.definition;
    const fingerprint = canonicalJson([collection, value]);
    refuseErasedKey(store, def, value, idempotencyKey);
    const replay = replayOf(store, idempotencyKey, fingerprint);
    if (replay !== null) return replay;
    checkAppendable(entry, value);
    const canonicalId = canonicalIdOf(def, value);
    const details = idempotencyKey === undefined ? {} : { idempotencyKey };
    const retryable = idempotencyKey !== undefined && !auto;
    return faults.run('append', { retryable, retryableBefore: true, details }, () => {
      const sealing = sealerFor(store, def, collection, value, canonicalId);
      const written = write(store, entry, collection, { sealing, source: edgeSource() });
      remember(store, idempotencyKey, fingerprint, written);
      return copyReceipt(written.receipt);
    });
  }

  /** The shred entry { $event: 'shred', subjectRef, reason, authority, requestedBy } of an erasure. */
  function appendShredEntry(store, entry, collection, value) {
    const source = { type: 'platform', principal: LEDGER_SERVICE };
    return copyReceipt(write(store, entry, collection, { sealing: () => ({ value, personal: [] }), source }).receipt);
  }

  return { append, appendShredEntry };
}
