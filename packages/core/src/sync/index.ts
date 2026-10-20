export {
  HLC_COUNTER_MAX, HLC_LENGTH, HLC_MAX_DRIFT_MS, clampRemote, compareHlc, decodeHlc, encodeHlc, hlcWall, isHlc, isNodeId,
  receiveHlc, tickHlc, type Hlc,
} from './hlc.ts';
export { CLOCK_SCOPE, SyncClock, newNodeId, type SyncClockDeps } from './clock.ts';
export { SYNC_KIND, SYNC_KINDS, clockKey, pairKey, parseClockKey, type SyncKind } from './keys.ts';
export {
  SFP_LENGTH, canonicalSourceIdentity, deriveFingerprintKey, fromSid, sourceFingerprint, toSid, type SyncRef,
} from './ref.ts';
export { RefResolver, buildResolver, resolveVodTarget, type FingerprintedSource, type VodTargetView } from './resolver.ts';
export { PENDING_MAX, PENDING_SCOPE, PendingStore } from './pending.ts';
export {
  TOMBSTONE_TTL_MS, clampStamp, expiredTombstone, isTombstone, lwwRegister, members, mergeElementSet, mergeLwwMap, mergeOrder,
  mergeRecords, pruneTombstones, wins, type MergeResult, type Stamped,
} from './merge.ts';
export {
  DELTA_MAX_BYTES, SNAPSHOT_MAX_BYTES, SYNCED_SETTINGS, decodePayload, encodePayload, payloadBytes,
  type PayloadEntry, type SyncPayload,
} from './payload.ts';
export { registerKey, type ProgressValue, type SyncRecord, type SyncValue, type TracksValue } from './types.ts';
export {
  RECOVERY_CODE_BYTES, RECOVERY_CODE_LENGTH, encodeRecoveryCode, formatRecoveryCode, newRecoveryCode, parseRecoveryCode,
} from './recovery.ts';
export {
  BACKUP_ENVELOPE_MAX_CHARS, BACKUP_PBKDF2_ITERATIONS, BACKUP_PLAINTEXT_MAX, BACKUP_SCHEMA, BackupError, isBackupEnvelope,
  newBackupKeys, openBackup, sealBackup, type BackupEnvelope, type BackupErrorReason,
} from './backupCrypto.ts';
export {
  SETTINGS_SCOPE, SYNTHETIC_NODE, applyVodRestore, exportSettings, exportSource, isSyntheticStamp, planSettingsRestore,
  planSourceRestore, registerMap, type SourceRestorePlan, type SourceState, type VodRestore,
} from './snapshot.ts';
export { BACKUP_FP_SCOPE, BackupService, type BackupDeps, type CreatedBackup, type RestoreSummary } from './backup.ts';
