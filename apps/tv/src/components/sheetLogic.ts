/**
 * Sheet (UI rethink spec 2026-10-26 §1.3): the one menu surface. Rows, selection, the 7-row scroll window, the footer,
 * frames per placement, tabs, in-place sub-pages, and adapters from the old menus' rows. Pure: no Solid, no Lightning.
 */
import type { PickerRow } from '../screens/homeMenuLogic.ts';
import { LAYOUT, LINE, SPACE } from '../shell/theme.ts';
import { firstSelectable, scrollTopFor, stepSelectable } from './virtualWindow.ts';

export type SheetPlacement = 'side' | 'bottom' | 'center';
export interface SheetIcon { src?: string; badge?: string }
export interface SheetRow {
  id: string;
  label: string;
  /** Right-aligned value column (Player options, the Settings chooser). */
  value?: string;
  /** In effect: the selected ✓ in accent. */
  checked?: boolean;
  /** A flag image or a short text badge left of the label. */
  icon?: SheetIcon;
  /** Draws "›": the caller opens another level itself (a two-level list with `resetKey`). */
  more?: boolean;
  /** Draws "›": OK opens this page in place, Back returns. */
  page?: SheetPage;
  /** A section title: drawn muted, never selected. */
  heading?: boolean;
  /** Muted at rest ("New list…"). */
  quiet?: boolean;
  /** Footer line while selected (a long release name). */
  help?: string;
}
export interface SheetPage { id: string; title: string; rows: readonly SheetRow[] }
export interface SheetTab { id: string; label: string; page: SheetPage }
/** Player options and the Settings chooser (was `OptionsMenu`'s `OptionItem`). */
export interface OptionItem { id: string; label: string; value?: string }
/** Action menus (was `ContextMenu`'s `ContextMenuItem`). */
export interface MenuItem<A extends string> { action: A; label: string }

export const SHEET_W = 640;
export const SHEET_ROW_H = 72;
export const SHEET_ROW_GAP = SPACE.s;
export const SHEET_PITCH = SHEET_ROW_H + SHEET_ROW_GAP;
export const SHEET_PAD = SPACE.l;
/** The title band above the rows (or the tabs). */
export const SHEET_HEAD = 64;
export const SHEET_TABS_H = 64;
export const SHEET_MAX_ROWS = 7;
export const SHEET_FOOTER_LINE = LINE.meta;
export const SHEET_ICON_W = 48;
export const SHEET_ICON_H = 36;
export const SHEET_CHECK_W = 48;
export const SHEET_MORE_W = 24;
export const SHEET_VALUE_W = 240;
export const DIALOG_W = 720;
export const DIALOG_PAD = SPACE.xl;

export const sheetSelectable = (r: SheetRow | undefined): boolean => r !== undefined && r.heading !== true;

export function sheetClamp(sel: number, rows: readonly SheetRow[]): number {
  return firstSelectable(Math.max(0, sel), rows.length, (i) => sheetSelectable(rows[i]));
}

export function sheetStep(sel: number, d: 1 | -1, rows: readonly SheetRow[]): number {
  return stepSelectable(sheetClamp(sel, rows), d, rows.length, (i) => sheetSelectable(rows[i]));
}

/** The row with `id` when it is still there, else `index` clamped (the old ContextMenu's rule). */
export function sheetFollow(id: string | undefined, index: number, rows: readonly SheetRow[]): number {
  const at = id === undefined ? -1 : rows.findIndex((r) => r.id === id);
  return at >= 0 && sheetSelectable(rows[at]) ? at : sheetClamp(index, rows);
}

export const sheetScroll = (sel: number, top: number, total: number): number => scrollTopFor(sel, top, SHEET_MAX_ROWS, total);

/** "▲" / "▼" when rows are hidden above / below the window. */
export function sheetMore(top: number, total: number): string {
  return [top > 0 ? '▲' : '', top + SHEET_MAX_ROWS < total ? '▼' : ''].filter(Boolean).join(' ');
}

/**
 * The footer: when any row has help, line 1 is the selected row's help ('' when it has none, so the sheet keeps its
 * height); then one line with the scroll marks and `footer` (a status or an attribution, never a key hint), if any.
 */
export function sheetFooter(rows: readonly SheetRow[], sel: number, footer: string | undefined, more: string): string[] {
  const out: string[] = [];
  if (rows.some((r) => r.help)) out.push(rows[sel]?.help ?? '');
  const last = [more, footer ?? ''].filter(Boolean).join(' · ');
  if (last) out.push(last);
  return out;
}

export const sheetListTop = (hasTabs: boolean): number => SHEET_PAD + SHEET_HEAD + (hasTabs ? SHEET_TABS_H : 0);

export function sheetFrame(placement: SheetPlacement, rowsShown: number, footerLines: number, hasTabs: boolean): { x: number; y: number; w: number; h: number } {
  const h = sheetListTop(hasTabs) + rowsShown * SHEET_PITCH - SHEET_ROW_GAP
    + (footerLines > 0 ? SPACE.s + footerLines * SHEET_FOOTER_LINE : 0) + SHEET_PAD;
  if (placement === 'bottom') {
    return { x: LAYOUT.safeX, y: LAYOUT.height - LAYOUT.safeY - h, w: LAYOUT.width - LAYOUT.safeX * 2, h };
  }
  if (placement === 'center') return { x: (LAYOUT.width - SHEET_W) / 2, y: (LAYOUT.height - h) / 2, w: SHEET_W, h };
  return { x: LAYOUT.width - LAYOUT.safeX - SHEET_W, y: LAYOUT.safeY, w: SHEET_W, h };
}

export const tabStep = (i: number, d: 1 | -1, n: number): number => Math.max(0, Math.min(n - 1, i + d));

/** In-place sub-pages: `sel[k]` is the selection on `pages[k]` when `pages[k + 1]` opened. */
export interface SheetStack { pages: readonly SheetPage[]; sel: readonly number[] }
export const stackOpen = (root: SheetPage): SheetStack => ({ pages: [root], sel: [] });
export const stackPush = (s: SheetStack, page: SheetPage, fromSel: number): SheetStack => ({ pages: [...s.pages, page], sel: [...s.sel, fromSel] });
export const stackPop = (s: SheetStack): SheetStack | undefined =>
  (s.pages.length <= 1 ? undefined : { pages: s.pages.slice(0, -1), sel: s.sel.slice(0, -1) });
export const stackTop = (s: SheetStack): SheetPage => s.pages[s.pages.length - 1]!;
/** The selection to restore on the page below the top one. */
export const stackRestore = (s: SheetStack): number => s.sel[s.sel.length - 1] ?? 0;

export function fromPickerRow(r: PickerRow, i: number): SheetRow {
  if (r.kind === 'heading') return { id: `heading:${i}`, label: r.label, heading: true };
  if (r.kind === 'new') return { id: `new:${i}`, label: r.label, quiet: true };
  return {
    id: r.id, label: r.label, checked: r.checked,
    ...(r.help !== undefined ? { help: r.help } : {}), ...(r.icon ? { icon: r.icon } : {}), ...(r.more ? { more: true } : {}),
  };
}

export const fromOptionItem = (o: OptionItem): SheetRow => ({ id: o.id, label: o.label, ...(o.value !== undefined ? { value: o.value } : {}) });
export const fromMenuItem = <A extends string>(it: MenuItem<A>): SheetRow => ({ id: it.action, label: it.label });

/** Dialog (a centred Sheet variant): title (one line), an optional line, an optional large detail, 1–2 buttons. */
export function dialogFrame(hasLine: boolean, hasDetail: boolean, buttonH: number): {
  x: number; y: number; w: number; h: number; titleY: number; lineY: number; detailY: number; buttonsY: number;
} {
  const titleY = DIALOG_PAD;
  let y = titleY + LINE.title;
  const lineY = y + SPACE.m;
  if (hasLine) y = lineY + LINE.body;
  const detailY = y + SPACE.m;
  if (hasDetail) y = detailY + LINE.title;
  const buttonsY = y + SPACE.xl;
  const h = buttonsY + buttonH + DIALOG_PAD;
  return { x: (LAYOUT.width - DIALOG_W) / 2, y: (LAYOUT.height - h) / 2, w: DIALOG_W, h, titleY, lineY, detailY, buttonsY };
}
