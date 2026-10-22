import { detectTextLanguage, isoLanguage, languageFromLabel } from '@iptv/core';
import type { TrackInfo } from '@iptv/player';

/** Past this much text without a clear language, a track is given up on (its buffer dropped). */
export const CUE_LANGUAGE_MAX_CHARS = 3000;
/** Detection is first tried once a track has this much text. */
const MIN_CHARS = 60;

export interface CueLanguageCollector {
  /**
   * One cue the stream's active subtitle track showed (`null` or empty: a cleared cue). `active` names that track; it
   * is only asked for a cue with text.
   */
  add(text: string | null, active: () => TrackInfo | undefined): void;
}

/**
 * Detects an embedded subtitle track's language from the first cues it shows (spec 2026-10-22-track-languages), for
 * tracks whose own data names none. Calls `onFound` once per track; per open (engine track ids change on reopen).
 */
export function cueLanguageCollector(onFound: (trackId: string, language: string) => void): CueLanguageCollector {
  const text = new Map<string, string>();
  const done = new Set<string>();
  return {
    add(cue, active) {
      if (!cue || cue.trim() === '') return;
      const t = active();
      if (!t || done.has(t.id)) return;
      if (isoLanguage(t.language) ?? languageFromLabel(t.label)) {
        done.add(t.id);
        return;
      }
      const all = `${text.get(t.id) ?? ''}\n${cue}`;
      const lang = all.length >= MIN_CHARS ? detectTextLanguage(all) : undefined;
      if (lang || all.length >= CUE_LANGUAGE_MAX_CHARS) {
        done.add(t.id);
        text.delete(t.id);
        if (lang) onFound(t.id, lang);
        return;
      }
      text.set(t.id, all);
    },
  };
}
