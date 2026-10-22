import { describe, expect, test } from 'vitest';
import type { SportsEventTile } from '@iptv/app-api';
import { byCompetition, matchGridLayout, matchSections, scrollToShow, sectionMove, sectionOf } from './matchesGridLogic.ts';

const NOW = new Date(2026, 9, 22, 20, 0).getTime(); // local 20:00
const M = 60_000;
const ev = (title: string, startMin: number, competition?: string): SportsEventTile => {
  const e: SportsEventTile = { key: title, title, start: NOW + startMin * M, stop: NOW + (startMin + 110) * M, channelCount: 2, followed: false };
  if (competition) e.competition = competition;
  return e;
};

describe('sections (spec 2026-10-22 §3.1)', () => {
  test('on air is Live now; before local midnight Later today; after it Tomorrow', () => {
    expect(sectionOf(ev('a', -10), NOW)).toBe('live');
    expect(sectionOf(ev('b', 3 * 60 + 59), NOW)).toBe('today');
    expect(sectionOf(ev('c', 4 * 60), NOW)).toBe('tomorrow');
  });
  test('grouped in section order, ranked order kept inside; empty sections are left out', () => {
    const r = matchSections([ev('later', 60), ev('live1', -5), ev('tmrw', 600), ev('live2', -20)], NOW);
    expect(r.order.map((e) => e.title)).toEqual(['live1', 'live2', 'later', 'tmrw']);
    expect(r.sections.map((s) => [s.id, s.from, s.to])).toEqual([['live', 0, 2], ['today', 2, 3], ['tomorrow', 3, 4]]);
    expect(r.sections[0]!.label).toBe('Live now');
    expect(matchSections([ev('x', 60)], NOW).sections.map((s) => s.id)).toEqual(['today']);
  });
  test('byCompetition matches the folded key; undefined keeps all', () => {
    const list = [ev('a', 0, 'Test Cup'), ev('b', 0, 'Northern Cup'), ev('c', 0)];
    expect(byCompetition(list, 'test cup').map((e) => e.title)).toEqual(['a']);
    expect(byCompetition(list, undefined)).toHaveLength(3);
  });
});

describe('layout, movement and scroll', () => {
  const F = { cols: 4, pitchX: 384, tileH: 136, rowGap: 24, labelH: 44, sectionGap: 16 };
  // live: 0..4 (5 tiles, two visual rows), today: 5..6
  const sections = [{ id: 'live', label: 'Live now', from: 0, to: 5 }, { id: 'today', label: 'Later today', from: 5, to: 7 }] as const;

  test('each section: a label, then rows of 4', () => {
    const l = matchGridLayout(sections, F);
    expect(l.labels).toEqual([{ id: 'live', label: 'Live now', y: 0 }, { id: 'today', label: 'Later today', y: 44 + 136 + 24 + 136 + 16 }]);
    expect(l.places[0]).toEqual({ x: 0, y: 44 });
    expect(l.places[3]).toEqual({ x: 3 * 384, y: 44 });
    expect(l.places[4]).toEqual({ x: 0, y: 44 + 160 });
    expect(l.places[5]).toEqual({ x: 0, y: 356 + 44 });
    expect(l.height).toBe(356 + 44 + 136);
  });

  test('moves in reading order across sections; short rows clamp; up from the first row is the top', () => {
    expect(sectionMove(sections, 4, 0, 'up')).toBe('top');
    expect(sectionMove(sections, 4, 0, 'left')).toBe(0);
    expect(sectionMove(sections, 4, 3, 'right')).toBe(3);
    expect(sectionMove(sections, 4, 3, 'down')).toBe(4);   // the second live row has one tile
    expect(sectionMove(sections, 4, 4, 'right')).toBe(4);
    expect(sectionMove(sections, 4, 4, 'down')).toBe(5);   // into Later today
    expect(sectionMove(sections, 4, 2, 'down')).toBe(4);
    expect(sectionMove(sections, 4, 6, 'up')).toBe(4);
    expect(sectionMove(sections, 4, 6, 'down')).toBe(6);   // last row: stays
  });

  test('scroll keeps the focused tile (and the space above it for a label) inside the view', () => {
    expect(scrollToShow(44, 136, 44, 0, 600)).toBe(0);
    expect(scrollToShow(800, 136, 44, 0, 600)).toBe(336);
    expect(scrollToShow(400, 136, 44, 500, 600)).toBe(356);
    expect(scrollToShow(44, 136, 44, 300, 600)).toBe(0);
  });
});
