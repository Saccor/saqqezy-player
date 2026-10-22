/** View all matches: sections, the grid's places, key movement and scroll (spec 2026-10-22 §3). Pure: no Solid, no Lightning. */
import type { SportsEventTile } from '@iptv/app-api';
import { competitionKey } from '@iptv/core';

export type MatchSectionId = 'live' | 'today' | 'tomorrow';
/** `from`/`to`: the section's index range in `order`. */
export interface MatchSection { id: MatchSectionId; label: string; from: number; to: number }
export const SECTION_LABELS: Record<MatchSectionId, string> = { live: 'Live now', today: 'Later today', tomorrow: 'Tomorrow' };
const SECTION_ORDER: readonly MatchSectionId[] = ['live', 'today', 'tomorrow'];

export function sectionOf(e: Pick<SportsEventTile, 'start' | 'stop'>, now: number): MatchSectionId {
  if (e.start <= now && now < e.stop) return 'live';
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return e.start < midnight.getTime() ? 'today' : 'tomorrow';
}

/** The events grouped by section (ranked order kept inside each); empty sections are left out. */
export function matchSections(events: readonly SportsEventTile[], now: number): { order: SportsEventTile[]; sections: MatchSection[] } {
  const by = new Map<MatchSectionId, SportsEventTile[]>(SECTION_ORDER.map((id) => [id, []]));
  for (const e of events) by.get(sectionOf(e, now))!.push(e);
  const order: SportsEventTile[] = [];
  const sections: MatchSection[] = [];
  for (const id of SECTION_ORDER) {
    const list = by.get(id)!;
    if (!list.length) continue;
    sections.push({ id, label: SECTION_LABELS[id], from: order.length, to: order.length + list.length });
    order.push(...list);
  }
  return { order, sections };
}

/** One competition's events (`key`: a folded competition key); undefined keeps all. */
export function byCompetition(events: readonly SportsEventTile[], key: string | undefined): readonly SportsEventTile[] {
  if (key === undefined) return events;
  return events.filter((e) => e.competition !== undefined && competitionKey(e.competition) === key);
}

export interface MatchGridFrame { cols: number; pitchX: number; tileH: number; rowGap: number; labelH: number; sectionGap: number }
export interface MatchGridLayout { labels: { id: MatchSectionId; label: string; y: number }[]; places: { x: number; y: number }[]; height: number }

/** Each section: its label, then rows of `cols` tiles; `places[i]` is tile i's position in the scrolling column. */
export function matchGridLayout(sections: readonly MatchSection[], f: MatchGridFrame): MatchGridLayout {
  const labels: MatchGridLayout['labels'] = [];
  const places: MatchGridLayout['places'] = [];
  let y = 0;
  sections.forEach((s, k) => {
    if (k > 0) y += f.sectionGap;
    labels.push({ id: s.id, label: s.label, y });
    y += f.labelH;
    for (let i = s.from; i < s.to; i++) {
      const j = i - s.from;
      places[i] = { x: (j % f.cols) * f.pitchX, y: y + Math.floor(j / f.cols) * (f.tileH + f.rowGap) };
    }
    const rows = Math.ceil((s.to - s.from) / f.cols);
    y += rows * f.tileH + (rows - 1) * f.rowGap;
  });
  return { labels, places, height: y };
}

/** The visual rows across all sections, in reading order. */
function visualRows(sections: readonly MatchSection[], cols: number): { from: number; to: number }[] {
  const rows: { from: number; to: number }[] = [];
  for (const s of sections) for (let i = s.from; i < s.to; i += cols) rows.push({ from: i, to: Math.min(i + cols, s.to) });
  return rows;
}

/** The index after a key: Left/Right within a row, Up/Down to the row above/below (any section), the column clamped. */
export function sectionMove(sections: readonly MatchSection[], cols: number, index: number, key: 'up' | 'down' | 'left' | 'right'): number | 'top' {
  const rows = visualRows(sections, cols);
  const r = rows.findIndex((x) => index >= x.from && index < x.to);
  if (r < 0) return 0;
  const row = rows[r]!;
  const col = index - row.from;
  if (key === 'left') return col === 0 ? index : index - 1;
  if (key === 'right') return index + 1 < row.to ? index + 1 : index;
  if (key === 'up') {
    if (r === 0) return 'top';
    const t = rows[r - 1]!;
    return Math.min(t.from + col, t.to - 1);
  }
  if (r === rows.length - 1) return index;
  const t = rows[r + 1]!;
  return Math.min(t.from + col, t.to - 1);
}

/** The column's scroll that shows a tile at `y` (and `labelH` above it, room for a section label) inside `viewH`. */
export function scrollToShow(y: number, h: number, labelH: number, scroll: number, viewH: number): number {
  if (y - labelH < scroll) return Math.max(0, y - labelH);
  if (y + h > scroll + viewH) return y + h - viewH;
  return scroll;
}
