/**
 * Where a subtitle file comes from: "Find subtitles online" (one row per language found), "Try another version" of the
 * loaded file's language, "Load subtitles from a link…" (the on-screen keyboard) and, on computers, a file. Each picker
 * is a back layer of its own; a search answered after its picker closed changes nothing. Not unit-tested: the pure
 * rules live in subtitleLogic.ts.
 */
import { createSignal } from 'solid-js';
import type { ElementNode } from '@lightningtv/solid';
import { api } from '../../api.ts';
import { VOD_COPY } from '../../copy.ts';
import type { PickerRow } from '../homeMenuLogic.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import {
  onlineFileId, onlineLanguageLabel, onlineLanguageRows, versionFileId, versionRows, type OnlineLanguage, type VersionInfo,
} from '../../vod/subtitleLogic.ts';
import type { VodCore } from './createVodCore.ts';
import type { LoadedSubtitleState } from './createLoadedSubtitle.ts';
import { SUB_ONLINE_ID, SUB_URL_ID, SUB_VERSIONS_ID, errName } from './layout.ts';

const SUBTITLE_FILE_TYPES = '.srt,.vtt,text/vtt,application/x-subrip';

export function createSubtitleFinder(c: VodCore, sub: LoadedSubtitleState, d: {
  /** After a picker closes: the controls' bar when it still shows, else the screen. */
  focusBarOrRoot: () => void;
}) {
  const { p } = c;
  const { focusBarOrRoot } = d;
  /** "Find subtitles online" is set up (the worker has the service's key). */
  const [onlineOk, setOnlineOk] = createSignal(false);
  /** The "Subtitles online" picker's rows (undefined: closed). */
  const [onlineRows, setOnlineRows] = createSignal<PickerRow[] | undefined>(undefined);
  /** The "Try another version" picker's rows (undefined: closed). */
  const [versionPickRows, setVersionPickRows] = createSignal<PickerRow[] | undefined>(undefined);
  /** The link being typed for "Load subtitles from a link…" (undefined: the keyboard is closed). */
  const [linkText, setLinkText] = createSignal<string | undefined>(undefined);
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined);
  let keyboardNode: ElementNode | undefined;
  let removeLinkEntry: (() => void) | undefined;
  let onlineNode: ElementNode | undefined;
  let removeOnline: (() => void) | undefined;
  /** Bumped per search, so a search answered after its picker closed changes nothing. */
  let onlineSearch = 0;
  /** The languages of the last online search (each with its versions). */
  let onlineLangs: OnlineLanguage[] = [];
  let versionsNode: ElementNode | undefined;
  let removeVersions: (() => void) | undefined;
  /** Bumped per versions list, so one answered after its picker closed changes nothing. */
  let versionsSearch = 0;
  /** The versions listed in the open picker, and the language they are in. */
  let versionList: { language: string; versions: VersionInfo[] } | undefined;

  // ---- subtitles found online ----

  const closeOnline = () => {
    onlineSearch++;
    removeOnline?.();
    removeOnline = undefined;
    setOnlineRows(undefined);
  };

  /** The "Subtitles online" picker: a searching row at once, then one row per language found for this title. */
  const openOnline = () => {
    const search = ++onlineSearch;
    setOnlineRows([{ kind: 'list', id: 'searching', label: VOD_COPY.searching, checked: false }]);
    removeOnline = router.pushOverlay(SUB_ONLINE_ID, () => {
      onlineSearch++;
      removeOnline = undefined;
      setOnlineRows(undefined);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (c.alive) onlineNode?.setFocus(); });
    api.findSubtitlesOnline(p.itemId, p.series?.id, sub.videoFps()).then((langs) => {
      if (!c.alive || search !== onlineSearch) return;
      if (langs.length === 0) {
        closeOnline();
        focusBarOrRoot();
        showToast(VOD_COPY.noneOnline);
        return;
      }
      onlineLangs = langs;
      setOnlineRows(onlineLanguageRows(langs));
    }, (err) => {
      console.warn('Subtitle search failed', errName(err));
      if (!c.alive || search !== onlineSearch) return;
      closeOnline();
      focusBarOrRoot();
      showToast(err instanceof Error && err.name === 'SubtitleError' ? err.message : VOD_COPY.searchFailed);
    });
  };

  /** A language picked: download its best file and turn it on. */
  const pickOnline = (row: PickerRow) => {
    if (row.kind !== 'list') return;
    const fileId = onlineFileId(row.id);
    if (fileId === undefined || sub.subBusy()) return;
    const lang = onlineLangs.find((l) => l.fileId === fileId);
    const label = lang ? `${onlineLanguageLabel(lang.language)}${lang.cc ? ' CC' : ''}` : row.label;
    const details = lang ? { language: lang.language, ...(lang.fps ? { fps: lang.fps } : {}), ...(lang.cc ? { cc: true } : {}) } : undefined;
    void sub.loadWith(() => api.loadOnlineSubtitle(p.itemId, fileId, label, details)).then((error) => {
      if (!c.alive) return;
      closeOnline();
      focusBarOrRoot();
      if (error) showToast(error);
    });
  };

  // ---- other versions of the loaded file's language ----

  const closeVersions = () => {
    versionsSearch++;
    versionList = undefined;
    removeVersions?.();
    removeVersions = undefined;
    setVersionPickRows(undefined);
  };

  /** "Try another version": the loaded file's language's versions (listed once per session), the loaded one checked. */
  const openVersions = () => {
    const online = sub.external()?.online;
    if (!online) return;
    const search = ++versionsSearch;
    setVersionPickRows([{ kind: 'list', id: 'searching', label: VOD_COPY.searching, checked: false }]);
    removeVersions = router.pushOverlay(SUB_VERSIONS_ID, () => {
      versionsSearch++;
      versionList = undefined;
      removeVersions = undefined;
      setVersionPickRows(undefined);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (c.alive) versionsNode?.setFocus(); });
    api.subtitleVersions(p.itemId, online.language, p.series?.id, sub.videoFps()).then((versions) => {
      if (!c.alive || search !== versionsSearch) return;
      if (versions.length === 0) {
        closeVersions();
        focusBarOrRoot();
        showToast(VOD_COPY.noOtherVersions);
        return;
      }
      versionList = { language: online.language, versions };
      setVersionPickRows(versionRows(versions, sub.external()?.online?.fileId));
    }, (err) => {
      console.warn('Subtitle versions failed', errName(err));
      if (!c.alive || search !== versionsSearch) return;
      closeVersions();
      focusBarOrRoot();
      showToast(err instanceof Error && err.name === 'SubtitleError' ? err.message : VOD_COPY.searchFailed);
    });
  };

  /** A version picked: download that one file and turn it on (the loaded one just closes the list). */
  const pickVersion = (row: PickerRow) => {
    if (row.kind !== 'list' || sub.subBusy()) return;
    const fileId = versionFileId(row.id);
    const list = versionList;
    const v = list?.versions.find((x) => x.fileId === fileId);
    if (fileId === undefined || !list || !v) return;
    if (fileId === sub.external()?.online?.fileId) {
      closeVersions();
      focusBarOrRoot();
      return;
    }
    const label = VOD_COPY.onlineVersionLabel(onlineLanguageLabel(list.language), Boolean(v.hearingImpaired));
    const details = { language: list.language, ...(v.fps ? { fps: v.fps } : {}), ...(v.hearingImpaired ? { cc: true } : {}) };
    void sub.loadWith(() => api.loadOnlineSubtitle(p.itemId, fileId, label, details)).then((error) => {
      if (!c.alive) return;
      closeVersions();
      focusBarOrRoot();
      if (error) showToast(error);
    });
  };

  // ---- a link or a file ----

  const closeLinkEntry = () => {
    removeLinkEntry?.();
    removeLinkEntry = undefined;
    setLinkText(undefined);
    setLinkError(undefined);
  };
  const openLinkEntry = () => {
    setLinkText('');
    setLinkError(undefined);
    removeLinkEntry = router.pushOverlay(SUB_URL_ID, () => {
      removeLinkEntry = undefined;
      setLinkText(undefined);
      setLinkError(undefined);
      focusBarOrRoot();
    });
    queueMicrotask(() => { if (c.alive) keyboardNode?.setFocus(); });
  };
  /** Done on the keyboard: load the link; on failure the keyboard stays open with the error. */
  const submitLink = async () => {
    const url = (linkText() ?? '').trim();
    if (!url || sub.subBusy()) return;
    setLinkError(undefined);
    const error = await sub.loadSubtitle({ url });
    if (!c.alive || linkText() === undefined) return;
    if (error) {
      setLinkError(error);
    } else {
      closeLinkEntry();
      focusBarOrRoot();
    }
  };
  /** A key on the link keyboard: the new text, and any error is cleared. */
  const typeLink = (v: string) => { setLinkText(v); setLinkError(undefined); };

  /** The computer's file dialog (opened from the key press or click itself, which the browser requires). */
  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = SUBTITLE_FILE_TYPES;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file || !c.alive) return;
      void file.arrayBuffer().then(async (buf) => {
        const error = await sub.loadSubtitle({ bytes: new Uint8Array(buf), name: file.name });
        if (error && c.alive) showToast(error);
      }, () => showToast(VOD_COPY.fileReadFailed));
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.appendChild(input);
    input.click();
    focusBarOrRoot();
  };

  return {
    onlineOk, setOnlineOk, onlineRows, versionPickRows, linkText, linkError,
    openOnline, closeOnline, pickOnline, openVersions, closeVersions, pickVersion,
    openLinkEntry, closeLinkEntry, submitLink, typeLink, pickFile,
    onlineRef: (el: ElementNode) => { onlineNode = el; },
    versionsRef: (el: ElementNode) => { versionsNode = el; },
    keyboardRef: (el: ElementNode) => { keyboardNode = el; },
    /** Unmount: this part's back layers go (without their close handlers). */
    dispose: () => {
      removeLinkEntry?.();
      router.removeOverlay(SUB_URL_ID);
      removeOnline?.();
      router.removeOverlay(SUB_ONLINE_ID);
      removeVersions?.();
      router.removeOverlay(SUB_VERSIONS_ID);
    },
  };
}

export type SubtitleFinder = ReturnType<typeof createSubtitleFinder>;
