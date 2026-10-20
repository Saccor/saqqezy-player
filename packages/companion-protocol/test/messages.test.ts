import { describe, expect, it } from 'vitest';
import { BACKUP_ENVELOPE_MAX_CHARS, emptyLayout, HEADER_VALUE_MAX, type BackupEnvelope } from '@iptv/core';
import {
  BACKUP_MESSAGE_MAX_CHARS, BACKUP_PROTOCOL, HEADERS_PROTOCOL, PROTOCOL_VERSION, REGIONS_PROTOCOL, isPhoneToTv, isTvToPhone, isUnknownPhoneMessage, isUnknownTvMessage, PHONE_TO_TV_TYPES, TV_TO_PHONE_TYPES,
  type PhoneToTv, type TvToPhone,
} from '../src/index.ts';

/** A well-formed sealed backup (contents are opaque here). */
function envelope(): BackupEnvelope {
  return { f: 'iptv-backup', v: 1, i: 100_000, s: 'A'.repeat(22) + '==', iv: 'B'.repeat(16), at: 1_700_000_000_000, ct: 'C'.repeat(64) };
}

/** One valid message per `t`. A Record over the union: adding a message type without a sample fails to compile. */
const PHONE: { [K in PhoneToTv['t']]: Extract<PhoneToTv, { t: K }> } = {
  hello: { t: 'hello', client: { kind: 'phone', label: 'Phone', protocol: 1 } },
  getState: { t: 'getState', haveVersion: 3 },
  ping: { t: 'ping' },
  getSource: { t: 'getSource', id: 'src-1' },
  ops: { t: 'ops', sourceId: 'src-1', baseVersion: 0, ops: [{ op: 'setHideNoEpg', value: true }] },
  addSource: { t: 'addSource', input: { kind: 'm3u', name: 'Home', playlistUrl: 'http://example.test/list.m3u' } },
  updateSource: { t: 'updateSource', source: { id: 'src-1', kind: 'm3u', name: 'Home', playlistUrl: 'http://example.test/list.m3u' } },
  deleteSource: { t: 'deleteSource', id: 'src-1' },
  setActiveSource: { t: 'setActiveSource', id: 'src-1' },
  refresh: { t: 'refresh', what: 'both' },
  backupSaved: { t: 'backupSaved', at: 1_700_000_000_000 },
  restore: { t: 'restore', backup: envelope(), code: '01234-56789-ABCDE-FGHJK-MNPQRS' },
  bye: { t: 'bye' },
};

const TV: { [K in TvToPhone['t']]: Extract<TvToPhone, { t: K }> } = {
  welcome: { t: 'welcome', tv: { label: 'TV', appVersion: '1.0.0', protocol: 1 } },
  state: {
    t: 'state',
    state: { version: 1, sources: [], groups: [], channels: [], layout: emptyLayout(), coverageKnown: false },
  },
  stateUnchanged: { t: 'stateUnchanged', version: 1 },
  source: { t: 'source', source: { id: 'src-1', kind: 'm3u', name: 'Home', playlistUrl: 'http://example.test/list.m3u' } },
  layoutChanged: { t: 'layoutChanged', sourceId: 'src-1', version: 2, layout: emptyLayout() },
  progress: { t: 'progress', phase: 'playlist', count: 10 },
  result: { t: 'result', requestMsgId: 7, ok: true },
  backup: { t: 'backup', backup: envelope(), tv: 'Living room TV' },
  bye: { t: 'bye' },
};

describe('phone -> TV message types', () => {
  it('PHONE_TO_TV_TYPES lists exactly the types isPhoneToTv accepts', () => {
    expect([...PHONE_TO_TV_TYPES].sort()).toEqual(Object.keys(PHONE).sort());
    for (const [t, msg] of Object.entries(PHONE)) {
      expect(msg.t).toBe(t);
      expect(isPhoneToTv(msg), t).toBe(true);
      expect(isUnknownPhoneMessage(msg), t).toBe(false);
      expect(isUnknownPhoneMessage({ t }), `${t} (malformed is not unknown)`).toBe(false);
    }
    expect(isPhoneToTv({ t: 'fromTheFuture' })).toBe(false);
    expect(isUnknownPhoneMessage({ t: 'fromTheFuture' })).toBe(true);
  });
});

describe('TV -> phone message types', () => {
  it('TV_TO_PHONE_TYPES lists exactly the types isTvToPhone accepts', () => {
    expect([...TV_TO_PHONE_TYPES].sort()).toEqual(Object.keys(TV).sort());
    for (const [t, msg] of Object.entries(TV)) {
      expect(msg.t).toBe(t);
      expect(isTvToPhone(msg), t).toBe(true);
      expect(isUnknownTvMessage(msg), t).toBe(false);
    }
    expect(isTvToPhone({ t: 'fromTheFuture' })).toBe(false);
  });

  it('isUnknownTvMessage: true only for a record whose t is a string the companion does not know', () => {
    expect(isUnknownTvMessage({ t: 'fromTheFuture' })).toBe(true);
    expect(isUnknownTvMessage({ t: 'state' })).toBe(false); // known t, even if malformed
    expect(isUnknownTvMessage({ t: 7 })).toBe(false);
    expect(isUnknownTvMessage({})).toBe(false);
    expect(isUnknownTvMessage(null)).toBe(false);
    expect(isUnknownTvMessage([{ t: 'x' }])).toBe(false);
  });
});

describe('source-scoped layout messages', () => {
  it('ops carries the source id it was made for; the TV validator requires a valid one', () => {
    const ok = { t: 'ops', sourceId: 'src-1', baseVersion: 0, ops: [{ op: 'setHideNoEpg', value: true }] };
    expect(isPhoneToTv(ok)).toBe(true);
    const { sourceId: _drop, ...without } = ok;
    expect(isPhoneToTv(without)).toBe(false);
    expect(isPhoneToTv({ ...ok, sourceId: '' })).toBe(false);
    expect(isPhoneToTv({ ...ok, sourceId: 7 })).toBe(false);
    expect(isPhoneToTv({ ...ok, sourceId: 'x'.repeat(2049) })).toBe(false);
    expect(isPhoneToTv({ ...ok, extra: 1 })).toBe(false);
  });

  it('layoutChanged carries the source id; the companion validator requires it and tolerates extra fields', () => {
    const ok = { t: 'layoutChanged', sourceId: 'src-1', version: 2, layout: emptyLayout() };
    expect(isTvToPhone(ok)).toBe(true);
    expect(isTvToPhone({ ...ok, future: true })).toBe(true);
    const { sourceId: _drop, ...without } = ok;
    expect(isTvToPhone(without)).toBe(false);
    expect(isTvToPhone({ ...ok, sourceId: 3 })).toBe(false);
  });
});

describe('protocol v2: source User-Agent and Referer (spec 2026-10-20-source-headers §6.3)', () => {
  const m3u = { kind: 'm3u', name: 'Home', playlistUrl: 'http://example.test/list.m3u' };
  const xt = { kind: 'xtream', name: 'X', server: 'http://example.test', username: 'u', password: 'p' };

  it('headers arrived in protocol 2', () => {
    expect(HEADERS_PROTOCOL).toBe(2);
  });

  it('the TV accepts userAgent and referrer on add and update, empty strings included (clear)', () => {
    expect(isPhoneToTv({ t: 'addSource', input: { ...m3u, userAgent: 'SyntheticAgent/1.0', referrer: 'http://ref.example.test/' } })).toBe(true);
    expect(isPhoneToTv({ t: 'updateSource', source: { ...xt, id: 'src-1', userAgent: '', referrer: '' } })).toBe(true);
    expect(isPhoneToTv({ t: 'updateSource', source: { ...m3u, id: 'src-1', userAgent: 'a'.repeat(HEADER_VALUE_MAX) } })).toBe(true);
  });

  it('with the TV limits: at most 512, no control characters, strings only', () => {
    expect(isPhoneToTv({ t: 'addSource', input: { ...m3u, userAgent: 'a'.repeat(HEADER_VALUE_MAX + 1) } })).toBe(false);
    expect(isPhoneToTv({ t: 'addSource', input: { ...m3u, userAgent: 'A\r\nX: 1' } })).toBe(false);
    expect(isPhoneToTv({ t: 'updateSource', source: { ...xt, id: 'src-1', referrer: 7 } })).toBe(false);
  });

  it('unknown fields are still rejected by the TV', () => {
    expect(isPhoneToTv({ t: 'addSource', input: { ...m3u, cookie: 'x' } })).toBe(false);
  });

  it('welcome may carry the TV header support; the companion accepts it', () => {
    const headers = { lists: { userAgent: false, referrer: false }, streams: { userAgent: true, referrer: false } };
    expect(isTvToPhone({ t: 'welcome', tv: { label: 'TV', appVersion: '1', protocol: 2, headers } })).toBe(true);
  });
});

describe('protocol v3: your countries (report 2026-10-20 §2.2)', () => {
  it('is protocol 3, regions from 3', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(REGIONS_PROTOCOL).toBe(3);
  });

  it('the TV accepts the show and region ops', () => {
    const ops = [
      { op: 'showGroups', ids: ['g:SE | Synthetic News'] },
      { op: 'unshowGroups', ids: ['g:SE | Synthetic News'] },
      { op: 'setGroupRegion', id: 'g:Mixed', codes: ['SE'] },
      { op: 'setGroupRegion', id: 'g:Mixed', codes: null },
    ];
    expect(isPhoneToTv({ t: 'ops', sourceId: 'src-1', baseVersion: 0, ops })).toBe(true);
    expect(isPhoneToTv({ t: 'ops', sourceId: 'src-1', baseVersion: 0, ops: [{ op: 'showGroups', ids: ['g:x'], extra: 1 }] })).toBe(false);
  });
});

describe('protocol v3: backup to the phone and restore from it', () => {
  it('is protocol 3, and backups need it', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(BACKUP_PROTOCOL).toBe(3);
  });

  it('the TV accepts restore and backupSaved only in their exact shape', () => {
    expect(isPhoneToTv({ t: 'restore', backup: envelope(), code: 'x', extra: 1 })).toBe(false);
    expect(isPhoneToTv({ t: 'restore', backup: { ...envelope(), f: 'other' }, code: 'x' })).toBe(false);
    expect(isPhoneToTv({ t: 'restore', backup: envelope(), code: 'x'.repeat(65) })).toBe(false);
    expect(isPhoneToTv({ t: 'restore', backup: envelope() })).toBe(false);
    expect(isPhoneToTv({ t: 'backupSaved', at: -1 })).toBe(false);
    expect(isPhoneToTv({ t: 'backupSaved' })).toBe(false);
  });

  it('a backup message stays within the 8 MiB message cap', () => {
    expect(BACKUP_MESSAGE_MAX_CHARS).toBeGreaterThan(BACKUP_ENVELOPE_MAX_CHARS);
    expect(BACKUP_MESSAGE_MAX_CHARS).toBeLessThan(8 * 1024 * 1024);
    const big = { ...envelope(), ct: 'C'.repeat(BACKUP_ENVELOPE_MAX_CHARS + 4) };
    expect(isTvToPhone({ t: 'backup', backup: big, tv: 'TV' })).toBe(false);
    expect(isPhoneToTv({ t: 'restore', backup: big, code: 'x' })).toBe(false);
  });

  it('the companion checks the backup envelope and the label', () => {
    expect(isTvToPhone({ t: 'backup', backup: envelope(), tv: 7 })).toBe(false);
    expect(isTvToPhone({ t: 'backup', backup: { nope: true }, tv: 'TV' })).toBe(false);
  });
});
