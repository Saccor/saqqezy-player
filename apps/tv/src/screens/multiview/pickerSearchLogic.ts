/** Pure logic for the multiview picker's search (spec 2026-10-22-multiview-picker-search). */
import { MULTIVIEW_COPY } from '../../copy.ts';

export const PICKER_SEARCH_LIMIT = 200;
export const PICKER_SEARCH_DEBOUNCE_MS = 150;

/** The search row's text: a muted prompt when empty, else the quoted query and, once known, how many matched. */
export function searchRowLabel(query: string, count: number | undefined): { text: string; muted: boolean } {
  const q = query.trim();
  if (q === '') return { text: MULTIVIEW_COPY.searchChannels, muted: true };
  return { text: count === undefined ? `"${q}"` : `"${q}" · ${count} found`, muted: false };
}

export type PickerBack = 'closeKeyboard' | 'clearQuery' | 'closePicker';

/** What Back does: close the keyboard, else clear the query, else close the picker. */
export function backDecision(s: { keyboardOpen: boolean; query: string }): PickerBack {
  if (s.keyboardOpen) return 'closeKeyboard';
  return s.query.trim() !== '' ? 'clearQuery' : 'closePicker';
}

/** Where focus goes after Done or Right on the keyboard: the list only when it has rows. */
export function focusAfterSearch(resultCount: number): 'list' | 'keyboard' {
  return resultCount > 0 ? 'list' : 'keyboard';
}

/** Request tokens: an older answer finishing after a newer request is not the latest and is dropped. */
export function createRequestTokens() {
  let seq = 0;
  return {
    next: () => ++seq,
    isLatest: (t: number) => t === seq,
    invalidate: () => { seq++; },
  };
}

/** The count to show for `query`: only an answer that belongs to that same query counts (else the row shows just the query). */
export function answerCount(query: string, answer: { query: string; count: number } | undefined): number | undefined {
  return answer !== undefined && answer.query === query.trim() ? answer.count : undefined;
}
