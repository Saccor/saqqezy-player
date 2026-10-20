import type { Layout, LayoutOp } from '../layout/types.ts';
import type { VodService } from '../service/vodService.ts';
import type { AppSettings } from '../settings.ts';
import type { Storage } from '../storage.ts';
import type { SourceConfig } from '../types.ts';
import { emptyVodLayout, type VodLayout } from '../vod/layout.ts';
import type { VodKind } from '../vod/types.ts';
import {
  BACKUP_PLAINTEXT_MAX, BackupError, fromBase64, importFingerprintKey, newBackupKeys, openBackup, toBase64,
  type BackupEnvelope,
} from './backupCrypto.ts';
import type { SyncClock } from './clock.ts';
import { mergeRecords } from './merge.ts';
import { decodePayload, encodePayload, type SyncPayload } from './payload.ts';
import { PendingStore } from './pending.ts';
import { newRecoveryCode } from './recovery.ts';
import { sourceFingerprint } from './ref.ts';
import {
  SETTINGS_SCOPE, exportSettings, exportSource, planSettingsRestore, planSourceRestore, registerMap, type SourceState,
} from './snapshot.ts';
import { registerKey, type SyncRecord } from './types.ts';

/** `syncMeta` scope of the fingerprint keys of restored backups (to match sources added later). */
export const BACKUP_FP_SCOPE = '#backupfp';
/** Fingerprint keys kept at most (the newest restores). */
export const BACKUP_FP_MAX = 5;
/** Version of the snapshot JSON inside the envelope. */
export const SNAPSHOT_VERSION = 1;

/** The decrypted content of a backup. */
interface Snapshot { v: 1; p: SyncPayload }

export interface BackupDeps {
  storage: Storage;
  clock: SyncClock;
  now?: () => number;
  /** PBKDF2 iterations (tests only). */
  iterations?: number;
  /** VOD user state, picks, splits and category layouts; without it a backup carries none. */
  vod?: Pick<VodService, 'getVodPicks' | 'getVodSplits' | 'getVodLayout' | 'applyRestore'>;
  loadLayout(sourceId: string): Promise<Layout>;
  /** Applies restored ops to a source's layout without stamping (AppApi routes the active source through its index). */
  applyLayout(sourceId: string, ops: LayoutOp[]): Promise<void>;
  getSettings(): Promise<AppSettings>;
  /** Saves restored settings without stamping. */
  saveSettings(patch: Partial<AppSettings>): Promise<unknown>;
}

export interface CreatedBackup {
  envelope: BackupEnvelope;
  /** The recovery code: shown once, never stored. */
  code: string;
  /** Records in the backup. */
  records: number;
  sources: number;
}

export interface RestoreSummary {
  /** Registers the restore changed on this device. */
  applied: number;
  /** Records kept for sources that are not on this device (yet). */
  pending: number;
  /** Local sources the backup matched. */
  sources: number;
  /** When the backup was made (ms). */
  at: number;
}

const VOD_KINDS: readonly VodKind[] = ['movie', 'series'];

/** Same value, or a removal of something that is not there. */
function sameValue(local: SyncRecord | undefined, remote: SyncRecord): boolean {
  if (!local) return remote.v === false || remote.v === null;
  return JSON.stringify(local.v) === JSON.stringify(remote.v);
}

/**
 * Sync phase S1 (§6.5): an encrypted snapshot of the synced set, under a key derived from a one-time recovery code,
 * and its restore through the same merge as sync. No server: the envelope travels through the phone companion or a
 * file. Sources and credentials are never part of it; a restored record finds its source by fingerprint, and one
 * whose source is not on this device stays pending until a matching source is added (`applyPending`).
 */
export class BackupService {
  private readonly now: () => number;
  private readonly pending: PendingStore;

  constructor(private readonly deps: BackupDeps) {
    this.now = deps.now ?? Date.now;
    this.pending = new PendingStore(deps.storage);
  }

  /** Makes a backup under a fresh recovery code. */
  async create(): Promise<CreatedBackup> {
    const { storage, clock } = this.deps;
    await clock.idle();
    const code = newRecoveryCode();
    const keys = await newBackupKeys(code, { iterations: this.deps.iterations });
    const sources = await storage.listSources();
    const records: SyncRecord[] = [];
    for (const s of sources) {
      const state = await this.sourceState(s.id, await sourceFingerprint(keys.fpKey, s));
      records.push(...exportSource(state, { unstamped: 'synthetic' }));
    }
    records.push(...exportSettings(await this.deps.getSettings(), await clock.clocks(SETTINGS_SCOPE), { unstamped: 'synthetic' }));
    const now = this.now();
    const snapshot: Snapshot = { v: SNAPSHOT_VERSION, p: encodePayload(records, now) };
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    if (plaintext.length > BACKUP_PLAINTEXT_MAX) throw new BackupError('tooLarge', 'The backup is too large.');
    return { envelope: await keys.seal(plaintext, now), code, records: records.length, sources: sources.length };
  }

  /** Opens a backup with its recovery code and merges it into this device. Throws `BackupError`. */
  async restore(envelope: unknown, code: string): Promise<RestoreSummary> {
    const opened = await openBackup(envelope, code);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(new TextDecoder().decode(opened.plaintext));
    } catch {
      throw new BackupError('invalid', 'This backup is damaged.');
    }
    if (typeof snapshot !== 'object' || snapshot === null || (snapshot as Snapshot).v !== SNAPSHOT_VERSION) {
      throw new BackupError('invalid', 'This backup is damaged.');
    }
    const remote = decodePayload((snapshot as Snapshot).p);
    const { storage, clock } = this.deps;
    await clock.idle();
    const summary: RestoreSummary = { applied: 0, pending: 0, sources: 0, at: opened.at };

    // Settings (not tied to a source).
    const settingsRecs = remote.filter((r) => r.k === 'st');
    if (settingsRecs.length) summary.applied += await this.restoreSettings(settingsRecs);

    // Source records, by fingerprint.
    const bySfp = new Map<string, SyncRecord[]>();
    for (const r of remote) {
      if (r.k === 'st') continue;
      const list = bySfp.get(r.ref.sfp);
      if (list) list.push(r);
      else bySfp.set(r.ref.sfp, [r]);
    }
    const locals = new Map<string, string[]>();
    for (const s of await storage.listSources()) {
      const sfp = await sourceFingerprint(opened.fpKey, s);
      const list = locals.get(sfp);
      if (list) list.push(s.id);
      else locals.set(sfp, [s.id]);
    }
    const waiting: SyncRecord[] = [];
    for (const [sfp, recs] of bySfp) {
      const ids = locals.get(sfp);
      if (!ids) {
        waiting.push(...recs);
        continue;
      }
      for (const id of ids) {
        summary.sources++;
        summary.applied += await this.restoreSource(id, sfp, recs);
      }
    }
    if (waiting.length) {
      await this.pending.add(waiting);
      await this.rememberKey(opened.fpRaw);
      summary.pending = waiting.length;
    }
    return summary;
  }

  /** Applies pending records whose source matches `source` (just added). Returns how many registers changed. */
  async applyPending(source: SourceConfig): Promise<number> {
    let applied = 0;
    for (const e of await this.deps.storage.listSyncMeta(BACKUP_FP_SCOPE)) {
      const raw = (e.value as { raw?: unknown } | undefined)?.raw;
      if (typeof raw !== 'string') continue;
      const sfp = await sourceFingerprint(await importFingerprintKey(fromBase64(raw)), source);
      const recs = await this.pending.take(sfp);
      if (recs.length) applied += await this.restoreSource(source.id, sfp, recs);
    }
    return applied;
  }

  pendingCount(): Promise<number> {
    return this.pending.count();
  }

  // ---- internals ----

  private async sourceState(sourceId: string, sfp: string): Promise<SourceState> {
    const { storage, clock, vod } = this.deps;
    const picks: Record<VodKind, Record<string, string>> = { movie: {}, series: {} };
    const splits: Record<VodKind, Set<string>> = { movie: new Set(), series: new Set() };
    const vodLayout: Record<VodKind, VodLayout> = { movie: emptyVodLayout(), series: emptyVodLayout() };
    if (vod) {
      for (const kind of VOD_KINDS) {
        picks[kind] = await vod.getVodPicks(sourceId, kind);
        splits[kind] = await vod.getVodSplits(sourceId, kind);
        vodLayout[kind] = await vod.getVodLayout(sourceId, kind);
      }
    }
    return {
      sourceId, sfp, picks, splits, vodLayout: vod ? vodLayout : undefined,
      layout: await this.deps.loadLayout(sourceId),
      clocks: await clock.clocks(sourceId),
      vodUser: vod ? await storage.listVodUser(sourceId) : [],
    };
  }

  /** Merges one source's records against what it holds now; applies the winners. Returns the registers changed. */
  private async restoreSource(sourceId: string, sfp: string, recs: readonly SyncRecord[]): Promise<number> {
    const state = await this.sourceState(sourceId, sfp);
    const local = registerMap(exportSource(state, { unstamped: 'skip' }));
    const { apply } = mergeRecords(local, recs, this.now());
    if (!apply.length) return 0;
    const current = registerMap(exportSource(state, { unstamped: 'synthetic' }));
    const changed = apply.filter((r) => !sameValue(current.get(registerKey(r)), r)).length;
    const plan = planSourceRestore(sourceId, state.layout, apply);
    if (plan.ops.length) await this.deps.applyLayout(sourceId, plan.ops);
    if (this.deps.vod && (plan.vod.length || plan.picks.length || plan.splits.length || plan.vodLayout.length)) await this.deps.vod.applyRestore(sourceId, plan);
    await this.deps.clock.adopt(sourceId, plan.stamps);
    return changed;
  }

  private async restoreSettings(recs: readonly SyncRecord[]): Promise<number> {
    const settings = await this.deps.getSettings();
    const clocks = await this.deps.clock.clocks(SETTINGS_SCOPE);
    const local = registerMap(exportSettings(settings, clocks, { unstamped: 'skip' }));
    const { apply } = mergeRecords(local, recs, this.now());
    if (!apply.length) return 0;
    const current = registerMap(exportSettings(settings, clocks, { unstamped: 'synthetic' }));
    const changed = apply.filter((r) => !sameValue(current.get(registerKey(r)), r)).length;
    const plan = planSettingsRestore(apply);
    if (Object.keys(plan.patch).length) await this.deps.saveSettings(plan.patch);
    await this.deps.clock.adopt(SETTINGS_SCOPE, plan.stamps);
    return changed;
  }

  /** Keeps the fingerprint key of a restored backup (HMAC only: it cannot open the backup), newest BACKUP_FP_MAX. */
  private async rememberKey(fpRaw: Uint8Array): Promise<void> {
    const { storage } = this.deps;
    const raw = toBase64(fpRaw);
    const key = raw.slice(0, 16);
    const all = await storage.listSyncMeta(BACKUP_FP_SCOPE);
    await storage.putSyncMeta([{ scope: BACKUP_FP_SCOPE, key, value: { raw, at: this.now() } }]);
    const others = all.filter((e) => e.key !== key)
      .sort((a, b) => ((b.value as { at?: number }).at ?? 0) - ((a.value as { at?: number }).at ?? 0));
    const drop = others.slice(BACKUP_FP_MAX - 1).map((e) => e.key);
    if (drop.length) await storage.deleteSyncMeta(BACKUP_FP_SCOPE, drop);
  }
}
