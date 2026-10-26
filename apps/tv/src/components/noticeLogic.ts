// apps/tv/src/components/noticeLogic.ts
/** Notice (spec 2026-10-26 §1.3): one pill, top right. Kinds, order, stacking, auto-hide. Pure: no Solid, no Lightning. */
import { LAYOUT, MOTION, SPACE, TYPE } from '../shell/theme.ts';

export type NoticeKind = 'info' | 'wait' | 'error';

export interface NoticeSpec {
  id: string;
  kind: NoticeKind;
  text: string;
  /** error: what OK (or a click) on it does, drawn as a label at the pill's end ("Try again"). */
  action?: string;
  spinner?: boolean;
  /** Number entry: the text is digits at TYPE.numeral. */
  numeral?: boolean;
}

export interface PlacedNotice { spec: NoticeSpec; x: number; y: number; w: number; h: number; textX: number; textW: number; actionX?: number }

export const NOTICE_H = 64;
export const NOTICE_NUMERAL_H = TYPE.numeral + SPACE.l * 2;
export const NOTICE_PAD = SPACE.l;
export const NOTICE_GAP = SPACE.s;
export const NOTICE_MIN_W = 240;
export const NOTICE_MAX_W = 1008;
/** Under the shell clock in the top-right corner. */
export const NOTICE_TOP = LAYOUT.safeY + 64;
export const NOTICE_RIGHT = LAYOUT.width - LAYOUT.safeX;
export const NOTICE_SPINNER = 36;
export const SPINNER_DOT = 6;
export const NOTICE_MAX_SHOWN = 3;

const KIND_ORDER: Readonly<Record<NoticeKind, number>> = { error: 0, wait: 1, info: 2 };

export function noticeOrder(list: readonly NoticeSpec[]): NoticeSpec[] {
  return list.map((s, i) => ({ s, i })).sort((a, b) => KIND_ORDER[a.s.kind] - KIND_ORDER[b.s.kind] || a.i - b.i).map((x) => x.s);
}

export function noticeStack(list: readonly NoticeSpec[], measure: (text: string, size: number) => number): PlacedNotice[] {
  const out: PlacedNotice[] = [];
  let y = NOTICE_TOP;
  for (const spec of noticeOrder(list).slice(0, NOTICE_MAX_SHOWN)) {
    const size = spec.numeral ? TYPE.numeral : TYPE.body;
    const h = spec.numeral ? NOTICE_NUMERAL_H : NOTICE_H;
    const lead = spec.spinner ? NOTICE_SPINNER + SPACE.m : 0;
    const actionText = spec.action ? measure(spec.action, TYPE.body) : 0;
    const actionW = spec.action ? actionText + SPACE.l : 0;
    const want = NOTICE_PAD * 2 + lead + measure(spec.text, size) + actionW;
    const w = Math.round(Math.min(NOTICE_MAX_W, Math.max(NOTICE_MIN_W, want)));
    const textX = NOTICE_PAD + lead;
    const textW = w - textX - NOTICE_PAD - actionW;
    out.push({ spec, x: NOTICE_RIGHT - w, y, w, h, textX, textW, ...(spec.action ? { actionX: w - NOTICE_PAD - actionText } : {}) });
    y += h + NOTICE_GAP;
  }
  return out;
}

/** Only info hides by itself; wait stays while its condition is true; error stays until acted on or Back. */
export const noticeAutoHides = (kind: NoticeKind): boolean => kind === 'info';

/**
 * How much longer an info notice stays (0: hide now). The window is `MOTION.autoHide` from the later of when it showed
 * and the last key press (it pauses while keys are pressed); `held` (a sheet or dialog is open) keeps it a full window.
 */
export function autoHideDelay(s: { shownAt: number; lastKeyAt: number; now: number; held: boolean }): number {
  if (s.held) return MOTION.autoHide;
  return Math.max(0, Math.max(s.shownAt, s.lastKeyAt) + MOTION.autoHide - s.now);
}

/** The spinner's eight dots (top-left corners) on a circle in a NOTICE_SPINNER box. */
export function spinnerDots(): { x: number; y: number }[] {
  const c = NOTICE_SPINNER / 2 - SPINNER_DOT / 2;
  const r = NOTICE_SPINNER / 2 - SPINNER_DOT;
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { x: Math.round(c + Math.cos(a) * r), y: Math.round(c + Math.sin(a) * r) };
  });
}
