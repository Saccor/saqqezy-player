import { Show, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { formatRecoveryCode } from '@iptv/core';
import { api } from '../../api.ts';
import { Keyboard, KEYBOARD_H, KEYBOARD_W } from '../../components/Keyboard.tsx';
import { SettingsList } from '../../components/SettingsList.tsx';
import { COMMON_COPY, SETTINGS_COPY } from '../../copy.ts';
import { shellBack, usePointerTarget } from '../../input/pointer.ts';
import { playback } from '../../playback/playback.ts';
import { router } from '../../shell/router.ts';
import { COLORS, LAYOUT } from '../../shell/theme.ts';
import { showToast } from '../../shell/Toast.tsx';
import { applyInitState, companionStatus, platformId, restoreWaitUntil, setRestoreWaitUntil } from '../../state/appState.ts';
import { isTvPlatform } from '../../video/engineConfig.ts';
import {
  BACKUP_DONE_LINE, RESTORE_CONFIRM, RESTORE_CONFIRM_LINE, backupDoneMessage, backupErrorCopy, codeEntryProblem, storageItems,
} from './backupLogic.ts';
import type { PageProps } from './shared.ts';

const KEYBOARD_ID = 'storageKeyboard';
const S = SETTINGS_COPY.storage;
/** Backup files can be saved and opened off TVs (desktop, browser); TVs back up to the phone. */
const FILES = !isTvPlatform(platformId);

/** Saves `data` as a file through the browser (desktop builds keep the browser's download handling). */
function download(data: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens the file picker; resolves with the chosen file's text, or undefined when nothing was chosen. */
function pickFile(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file || file.size > 8 * 1024 * 1024) { resolve(undefined); return; }
      file.text().then(resolve, () => resolve(undefined));
    };
    input.click();
  });
}

/**
 * Storage: clear the cached channels, guide, movies and series (sources, favourites and watch progress stay), then
 * download them again; back up to the phone and restore from it (sync phase S1); off TVs also backup files.
 */
export function StoragePage(props: PageProps) {
  const [sel, setSel] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  /** Restore from a file: the file's text while its recovery code is typed. */
  const [entry, setEntry] = createSignal<{ data: string; value: string; error?: string } | undefined>(undefined);
  let alive = true;
  let listNode: ElementNode | undefined;
  let keyboardNode: ElementNode | undefined;
  let removeKeyboard: (() => void) | undefined;

  const waiting = () => {
    const until = restoreWaitUntil();
    return until !== undefined && until > now();
  };
  // The wait ends by itself: redraw the row then.
  createEffect(() => {
    const until = restoreWaitUntil();
    if (until === undefined) return;
    const timer = setTimeout(() => { setNow(Date.now()); if (Date.now() >= until) setRestoreWaitUntil(undefined); }, Math.max(0, until - Date.now()) + 50);
    onCleanup(() => clearTimeout(timer));
  });
  const items = () => storageItems({ connected: companionStatus().state === 'connected', waiting: waiting(), files: FILES });

  /** Shows the recovery code once. */
  const showCode = (where: 'phone' | 'file', code: string) => props.confirm(backupDoneMessage(where), S.done, { single: true, line: BACKUP_DONE_LINE, detail: formatRecoveryCode(code) });

  const clearCache = async () => {
    if (!(await props.confirm(S.clearTitle, S.clearYes, { line: S.clearLine }))) return;
    const done = props.busy(S.clearing);
    playback.stop(); // the cached list the stream came from is gone
    try {
      applyInitState(await api.clearCache());
      done();
      showToast(S.cleared);
      api.refresh('both').catch((err: unknown) => {
        console.warn('Refresh after clear failed', err instanceof Error ? err.name : 'Error');
        showToast(S.downloadFailed);
      });
    } catch (err) {
      done();
      console.warn('Clear cache failed', err instanceof Error ? err.name : 'Error');
      showToast(S.clearFailed);
    }
  };

  const backupToPhone = async () => {
    const done = props.busy(S.sending);
    try {
      const { code } = await api.backupToPhone();
      done();
      await showCode('phone', code);
    } catch (err) {
      done();
      console.warn('Backup to phone failed', err instanceof Error ? err.name : 'Error');
      showToast(backupErrorCopy(err));
    }
  };

  const restoreFromPhone = async () => {
    if (waiting()) {
      setRestoreWaitUntil(undefined);
      showToast(S.stoppedWaiting);
      api.armPhoneRestore(false).catch(() => { /* the wait also ends by itself */ });
      return;
    }
    if (!(await props.confirm(RESTORE_CONFIRM, S.restoreYes, { line: RESTORE_CONFIRM_LINE }))) return;
    try {
      const { until } = await api.armPhoneRestore(true);
      setNow(Date.now());
      setRestoreWaitUntil(until);
      showToast(SETTINGS_COPY.backup.waiting);
    } catch (err) {
      console.warn('Arm restore failed', err instanceof Error ? err.name : 'Error');
      showToast(S.restoreFailed);
    }
  };

  const backupToFile = async () => {
    const done = props.busy(S.making);
    try {
      const file = await api.backupToFile();
      download(file.data, file.fileName);
      done();
      await showCode('file', file.code);
    } catch (err) {
      done();
      console.warn('Backup file failed', err instanceof Error ? err.name : 'Error');
      showToast(backupErrorCopy(err));
    }
  };

  // The code keyboard is a Back layer: Back closes it and returns to the list.
  const focusList = () => queueMicrotask(() => { if (alive && !entry()) listNode?.setFocus(); });
  const closeKeyboard = () => { removeKeyboard = undefined; setEntry(undefined); focusList(); };
  const dismissKeyboard = () => { if (entry()) { removeKeyboard?.(); closeKeyboard(); } };
  const restoreFromFile = async () => {
    const data = await pickFile();
    if (!alive || data === undefined) return;
    setEntry({ data, value: '' });
    removeKeyboard = router.pushOverlay(KEYBOARD_ID, closeKeyboard);
    queueMicrotask(() => keyboardNode?.setFocus());
  };
  const submitCode = async () => {
    const e = entry();
    if (!e) return;
    const problem = codeEntryProblem(e.value);
    if (problem) { setEntry({ ...e, error: problem }); return; }
    dismissKeyboard();
    const done = props.busy(S.restoring);
    try {
      // The result's toast comes with the `backupRestored` event.
      await api.restoreFromFile(e.data, e.value);
      done();
    } catch (err) {
      done();
      console.warn('Restore from file failed', err instanceof Error ? err.name : 'Error');
      showToast(backupErrorCopy(err, S.restoreFileFailed));
    }
  };

  const onOk = (id: string) => {
    const item = items().find((i) => i.id === id);
    if (item?.disabled) { if (item.help) showToast(item.help); return; }
    if (id === 'clear') void clearCache();
    else if (id === 'backupPhone') void backupToPhone();
    else if (id === 'restorePhone') void restoreFromPhone();
    else if (id === 'backupFile') void backupToFile();
    else if (id === 'restoreFile') void restoreFromFile();
  };

  onCleanup(() => { alive = false; removeKeyboard?.(); router.removeOverlay(KEYBOARD_ID); props.register(undefined); });
  return (
    <>
      <SettingsList ref={(el) => { listNode = el; props.register(el); }} x={props.x} y={props.y} width={props.width} height={props.height}
        items={items()} selected={sel()} onSelect={setSel} onOk={onOk} onLeftEdge={props.onLeftEdge} />
      <Show when={entry()}>{(e) => {
        let scrim: ElementNode | undefined;
        // As in DisplayPage: a click outside the keyboard is Back (cancel).
        usePointerTarget({ node: () => scrim, onClick: () => shellBack(), onContextMenu: () => shellBack(), onWheel: () => true });
        return (
          <View ref={(el) => { scrim = el; }} x={0} y={0} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={70}>
            <Keyboard ref={(el) => { keyboardNode = el; }} x={(LAYOUT.width - KEYBOARD_W) / 2} y={(LAYOUT.height - KEYBOARD_H) / 2}
              label={S.recoveryCode} value={e().value} error={e().error}
              onChange={(v) => { const cur = entry(); if (cur) setEntry({ data: cur.data, value: v.slice(0, 64) }); }}
              onDone={() => void submitCode()} />
          </View>
        );
      }}</Show>
    </>
  );
}
