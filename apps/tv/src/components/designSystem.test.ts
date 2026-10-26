import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const gone = (rel: string) => expect(existsSync(join(SRC, rel)), `${rel} should be deleted`).toBe(false);
const there = (rel: string) => expect(existsSync(join(SRC, rel)), `${rel} should exist`).toBe(true);
/** A file that a later task deletes passes trivially (InfoBanner after Task 15). */
const lacks = (rel: string, re: RegExp) => {
  if (!existsSync(join(SRC, rel))) return;
  expect(readFileSync(join(SRC, rel), 'utf8'), `${rel} still has ${re}`).not.toMatch(re);
};

describe('design system 2.0 (spec 2026-10-26 §1.3): new components exist, replaced ones are deleted', () => {
  it('Badge replaces MediaBadges', () => {
    there('components/Badge.tsx');
    gone('components/MediaBadges.tsx');
    lacks('components/InfoBanner.tsx', /MediaBadges/);
    lacks('screens/VodPlay.tsx', /MediaBadges/);
  });
  it('Notice replaces StatusPill and the Toast view', () => {
    there('components/Notice.tsx');
    gone('components/StatusPill.tsx');
    lacks('shell/Toast.tsx', /export function Toast\(/);
    lacks('screens/Player.tsx', /useToastFloor/);
    lacks('screens/VodPlay.tsx', /useToastFloor/);
  });
  it('Notice replaces CooldownNotice, NumberEntry, OfflineBadge and PhoneBadge', () => {
    gone('components/CooldownNotice.tsx');
    gone('components/NumberEntry.tsx');
    lacks('App.tsx', /function OfflineBadge/);
    lacks('screens/live/LiveTv.tsx', /function PhoneBadge/);
    lacks('components/VolumeOsd.tsx', /NumberEntry/);
  });
  it('Dialog replaces ConfirmDialog', () => {
    there('components/Dialog.tsx');
    gone('shell/ConfirmDialog.tsx');
  });
  it('Sheet replaces ContextMenu', () => {
    there('components/Sheet.tsx');
    gone('components/ContextMenu.tsx');
  });
  it('Sheet replaces OptionsMenu and choiceMenu', () => {
    gone('components/OptionsMenu.tsx');
    gone('components/optionsMenuLogic.ts');
    gone('components/choiceMenu.tsx');
  });
  it('Sheet replaces ListPicker, and no sheet carries a key-hint footer', () => {
    gone('components/ListPicker.tsx');
    gone('components/listPickerLogic.ts');
    for (const f of ['screens/live/LiveTv.tsx', 'screens/MovieDetail.tsx', 'screens/SeriesDetail.tsx', 'screens/VodBrowse.tsx', 'screens/VodGrid.tsx', 'screens/VodPlay.tsx']) {
      lacks(f, /Back closes/);
    }
  });
  it('one focus style per kind: no hover colour, no selected fill, no extra rings', () => {
    lacks('components/FocusRing.tsx', /<Show/);
    lacks('screens/multiview/Multiview.tsx', /border=\{\{ width: 4/);
    lacks('screens/AddSource.tsx', /border=\{\{ width: 2/);
    lacks('components/CountryGrid.tsx', /color: COLORS\.accent \}/);
  });
  it('Tile and Row replace PosterTile, WideTile, PosterRow and WideRow', () => {
    there('components/Tile.tsx');
    there('components/Row.tsx');
    for (const f of ['PosterTile', 'WideTile', 'PosterRow', 'WideRow']) gone(`components/${f}.tsx`);
  });
  it('Tile replaces EpisodeCard, CountryGrid Chip and AddSource TypeTile', () => {
    gone('components/EpisodeRow.tsx');
    lacks('components/CountryGrid.tsx', /function Chip\(/);
    lacks('screens/AddSource.tsx', /function TypeTile\(/);
  });
  it('InfoBlock and KeyValuePanel replace InfoStrip, LiveInfo, InfoBanner and StreamInfoPanel', () => {
    there('components/InfoBlock.tsx');
    there('components/KeyValuePanel.tsx');
    for (const f of ['components/InfoStrip.tsx', 'screens/live/LiveInfo.tsx', 'components/InfoBanner.tsx', 'components/StreamInfoPanel.tsx']) gone(f);
  });
  it('phase 1 acceptance: the eight components exist and every replaced one is gone', () => {
    for (const f of ['Sheet', 'Dialog', 'Notice', 'Badge', 'Tile', 'Row', 'InfoBlock', 'KeyValuePanel']) there(`components/${f}.tsx`);
    for (const f of [
      'components/ListPicker.tsx', 'components/ContextMenu.tsx', 'components/OptionsMenu.tsx', 'components/choiceMenu.tsx',
      'shell/ConfirmDialog.tsx', 'components/StatusPill.tsx', 'components/CooldownNotice.tsx', 'components/NumberEntry.tsx',
      'components/MediaBadges.tsx', 'components/PosterTile.tsx', 'components/WideTile.tsx', 'components/EpisodeRow.tsx',
      'components/PosterRow.tsx', 'components/WideRow.tsx', 'components/InfoStrip.tsx', 'components/InfoBanner.tsx',
      'components/StreamInfoPanel.tsx', 'screens/live/LiveInfo.tsx',
    ]) gone(f);
    lacks('App.tsx', /function OfflineBadge/);
    lacks('screens/live/LiveTv.tsx', /function PhoneBadge/);
    lacks('screens/AddSource.tsx', /function TypeTile/);
    lacks('components/CountryGrid.tsx', /function Chip\(/);
  });
  it('one focus style per kind: no screen draws its own ring or hover colour', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx$/.test(n)) continue;
        const t = readFileSync(p, 'utf8');
        if (/COLORS\.(hover|selected)/.test(t) || (/border=\{\{ width: FOCUS\.ring/.test(t) && !p.endsWith('FocusRing.tsx'))) offenders.push(p);
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
