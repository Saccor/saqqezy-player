/**
 * Backup and restore in the worker (sync phase S1): encrypted backups to the phone or a file, and restores from
 * either. The recovery code is shown once and never stored; the backup is opened outside the index lock.
 */
import {
  BACKUP_ENVELOPE_MAX_CHARS, BACKUP_FP_SCOPE, BackupError, BackupService, applyOps, isBackupEnvelope,
  type AppSettings, type BackupEnvelope, type Layout, type LayoutOp, type RestoreSummary, type SourceConfig, type SourceService,
  type Storage, type VodService,
} from '@iptv/core';
import type { AppEvent, CompanionControl, LayoutOrigin } from './types.ts';

/** How long "Restore from your phone" waits for the phone (§6.5 S1). */
export const RESTORE_WAIT_MS = 5 * 60_000;

/** What a restore changed for the active source, so `finishRestore` refreshes exactly that. */
interface RestoreRun { origin: LayoutOrigin; layout: boolean; vodUser: boolean; vodGrouping: boolean }
const newRestoreRun = (origin: LayoutOrigin): RestoreRun => ({ origin, layout: false, vodUser: false, vodGrouping: false });

export interface BackupControllerDeps {
  service: SourceService;
  storage: Storage;
  emit: (e: AppEvent) => void;
  now: () => number;
  /** PBKDF2 iterations of new backups (tests only; the default is BACKUP_PBKDF2_ITERATIONS). */
  iterations: number | undefined;
  vod: VodService | undefined;
  companion: () => CompanionControl | undefined;
  activeId: () => string | undefined;
  /** The active source's layout (its index's). */
  layout: () => Layout;
  /** Stores the active source's new layout through its index (AppApi's `commitLayoutLocked`). Caller holds the index lock. */
  commitLayout: (id: string, before: Layout, layout: Layout, origin: LayoutOrigin) => Promise<void>;
  /** Runs `fn` under the index lock. */
  withIndex: <T>(fn: () => Promise<T>) => Promise<T>;
  settings: () => Promise<AppSettings>;
  /** Restored settings: AppApi's `applySettings` without stamping, under the index lock. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** The VOD screens re-read what a restore changed for the active source (VodController.restored). */
  vodRestored: (id: string, what: { user: boolean; grouping: boolean }) => void;
  /** Records a failure (scrubbed, in diagnostics): AppApi's `record`. */
  record: (where: string, err: unknown) => void;
}

export class BackupController {
  private backupSvc: BackupService | undefined;
  /** Until when a restore sent from the phone is accepted (the user opened "Restore from your phone"). */
  private restoreUntil = 0;
  /**
   * The restore being applied now (under the index lock): who asked, and what it changed for the active source. Its
   * layout and VOD events are held back and sent once when it is done (`finishRestore`).
   */
  private restoring: RestoreRun | undefined;

  constructor(private readonly deps: BackupControllerDeps) {}

  /**
   * True while a restore is being applied: the layout change is noted, and told the UI once when the restore is done
   * (the caller sends no event of its own).
   */
  noteLayout(): boolean {
    if (!this.restoring) return false;
    this.restoring.layout = true;
    return true;
  }

  /** See AppApi.backupToPhone. */
  async toPhone(): Promise<{ code: string; records: number }> {
    const companion = this.deps.companion();
    if (!companion?.sendBackup || companion.status().state !== 'connected') {
      throw Object.assign(new Error('Connect your phone first: Settings → Phone and computer.'), { name: 'NoCompanion' });
    }
    const made = await this.backups().create();
    await companion.sendBackup(made.envelope);
    return { code: made.code, records: made.records };
  }

  /** See AppApi.backupToFile. */
  async toFile(): Promise<{ code: string; data: string; fileName: string; records: number }> {
    const made = await this.backups().create();
    const day = new Date(made.envelope.at).toISOString().slice(0, 10);
    return { code: made.code, data: JSON.stringify(made.envelope), fileName: `tv-backup-${day}.json`, records: made.records };
  }

  /** See AppApi.restoreFromFile. */
  async fromFile(data: string, code: string): Promise<RestoreSummary> {
    let envelope: unknown;
    try {
      envelope = typeof data === 'string' && data.length <= BACKUP_ENVELOPE_MAX_CHARS + 4096 ? JSON.parse(data) : undefined;
    } catch {
      envelope = undefined;
    }
    if (!isBackupEnvelope(envelope)) throw new BackupError('invalid', 'This file is not a backup from this app.');
    return this.restoreBackup(envelope, code, 'local');
  }

  /** See AppApi.armPhoneRestore. */
  async armPhone(on: boolean): Promise<{ until: number | undefined }> {
    this.restoreUntil = on ? this.deps.now() + RESTORE_WAIT_MS : 0;
    return { until: on ? this.restoreUntil : undefined };
  }

  /** See AppApi.restoreFromCompanion. */
  async fromCompanion(envelope: BackupEnvelope, code: string): Promise<RestoreSummary> {
    if (this.deps.now() >= this.restoreUntil) {
      throw Object.assign(new Error('On the TV, open Settings → Storage → Restore from your phone first.'), { name: 'NotReady' });
    }
    const res = await this.restoreBackup(envelope, code, 'remote');
    this.restoreUntil = 0;
    return res;
  }

  private backups(): BackupService {
    const vod = this.deps.vod;
    this.backupSvc ??= new BackupService({
      storage: this.deps.storage, clock: this.deps.service.syncClock, now: this.deps.now, iterations: this.deps.iterations,
      vod: vod && {
        getVodPicks: (id, kind) => vod.getVodPicks(id, kind),
        getVodSplits: (id, kind) => vod.getVodSplits(id, kind),
        getVodLayout: (id, kind) => vod.getVodLayout(id, kind),
        applyRestore: async (id, plan) => {
          await vod.applyRestore(id, plan);
          // Noted for the active source only: another source's VOD state is read when it becomes active.
          const run = this.restoring;
          if (!run || id !== this.deps.activeId()) return;
          if (plan.vod.length) run.vodUser = true;
          if (plan.picks.length || plan.splits.length || plan.vodLayout?.length) run.vodGrouping = true;
        },
      },
      loadLayout: (id) => (id === this.deps.activeId() ? Promise.resolve(this.deps.layout()) : this.deps.service.loadLayout(id)),
      applyLayout: (id, ops) => this.applyRestoredLayout(id, ops),
      getSettings: () => this.deps.settings(),
      saveSettings: (patch) => this.deps.saveSettings(patch),
    });
    return this.backupSvc;
  }

  /**
   * Opens the backup first, outside the index lock: the PBKDF2 derivation is the slow step on a TV and touches no
   * state, so channel calls never queue behind it. Only the merge runs under the lock (the active source's layout
   * changes through its index). Then refreshes exactly what changed and tells the UI.
   */
  private async restoreBackup(envelope: unknown, code: string, origin: LayoutOrigin): Promise<RestoreSummary> {
    const opened = await this.backups().open(envelope, code);
    const run = newRestoreRun(origin);
    const res = await this.deps.withIndex(() => this.restoringAs(run, () => this.backups().apply(opened)))
      .finally(() => this.finishRestore(run));
    this.deps.emit({ type: 'backupRestored', origin, applied: res.applied, pending: res.pending, sources: res.sources, at: res.at });
    return res;
  }

  /** Applies what a restored backup kept for `source` (just added). Never fails the add. */
  async applyPending(source: SourceConfig): Promise<void> {
    try {
      if (!(await this.deps.storage.listSyncMeta(BACKUP_FP_SCOPE)).length) return;
      const run = newRestoreRun('local');
      await this.deps.withIndex(() => this.restoringAs(run, () => this.backups().applyPending(source)))
        .finally(() => this.finishRestore(run));
    } catch (err) {
      this.deps.record('applyPendingBackup', err);
    }
  }

  /** Runs a restore's merge with `run` noting what it changes. Caller holds the index lock. */
  private async restoringAs<T>(run: RestoreRun, fn: () => Promise<T>): Promise<T> {
    this.restoring = run;
    try {
      return await fn();
    } finally {
      this.restoring = undefined;
    }
  }

  /**
   * After a restore (a failed one too, for what it applied), the screens re-read exactly what changed: one
   * `layoutChanged` marked `restored` (no toast of its own) when the active layout or its index changed, and the VOD
   * user map or category config is read again (`vodRefreshed`). Restored settings went through `applySettings`.
   */
  private finishRestore(run: RestoreRun): void {
    if (run.layout) {
      this.deps.emit({
        type: 'layoutChanged', version: this.deps.layout().version, origin: run.origin === 'remote' ? 'remote' : 'local', restored: true,
      });
    }
    const id = this.deps.activeId();
    if (id && (run.vodUser || run.vodGrouping)) this.deps.vodRestored(id, { user: run.vodUser, grouping: run.vodGrouping });
  }

  /** Restored layout ops: the active source through its index (caller holds the index lock), others in storage. */
  private async applyRestoredLayout(id: string, ops: LayoutOp[]): Promise<void> {
    if (id !== this.deps.activeId()) {
      await this.deps.service.updateLayout(id, (l) => {
        const r = applyOps(l, ops);
        return r.changed ? r.layout : undefined;
      });
      return;
    }
    const before = this.deps.layout();
    const res = applyOps(before, ops);
    if (res.changed) await this.deps.commitLayout(id, before, res.layout, this.restoring?.origin ?? 'local');
  }
}
