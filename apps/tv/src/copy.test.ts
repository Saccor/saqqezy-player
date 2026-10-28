import { describe, expect, it } from 'vitest';
import * as COPY from './copy.ts';
import { COPY_EXCEPTIONS, collectCopy, copyViolations } from './copy/rules.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTokens } from '../../../tools/lint/tokenLint.ts';
import { CATCHUP_COPY, COUNTRIES_COPY, FAV_COPY, LAZY_COPY, MULTIVIEW_COPY, favChangedToast, favToggleLabel } from './copy.ts';

describe('favourites copy', () => {
  it('is lowercase "favourites" everywhere, and the failure toast is one sentence', () => {
    for (const s of Object.values(FAV_COPY)) expect(s).toMatch(/favourites/);
    for (const s of Object.values(FAV_COPY)) expect(s).not.toMatch(/Favourites/);
    expect(FAV_COPY.failed).toBe("Couldn't change favourites.");
  });

  it('the menu label says what a press does; the toast says what is now true', () => {
    expect(favToggleLabel(false)).toBe('Add to favourites');
    expect(favToggleLabel(true)).toBe('Remove from favourites');
    expect(favChangedToast(true)).toBe('Added to favourites');
    expect(favChangedToast(false)).toBe('Removed from favourites');
  });
});

describe('catch-up copy', () => {
  /** CLAUDE.md rule 3: no piracy-flavoured or provider wording in UI text. */
  const BANNED = /\b(free|premium|vip|cancel|subscription|provider|seller|reseller|sports? league|ppv)\b/i;
  const all = () => {
    const out: string[] = [];
    for (const v of Object.values(CATCHUP_COPY)) if (typeof v === 'string') out.push(v);
    for (const n of [0, 1, 3]) out.push(CATCHUP_COPY.daysLeft(n), CATCHUP_COPY.tooOld(n));
    out.push(CATCHUP_COPY.nextTitle('Programme 4'));
    return out;
  };

  it('is neutral', () => {
    for (const s of all()) expect(s, s).not.toMatch(BANNED);
  });

  it('days left and too old read naturally', () => {
    expect(CATCHUP_COPY.daysLeft(2)).toBe('Catch-up · 2 days left');
    expect(CATCHUP_COPY.daysLeft(1)).toBe('Catch-up · 1 day left');
    expect(CATCHUP_COPY.daysLeft(0)).toBe('Catch-up · Last day');
    expect(CATCHUP_COPY.tooOld(3)).toBe('Not available: older than 3 days');
    expect(CATCHUP_COPY.notAvailable).toBe('Not available. Your source did not return this programme.');
  });
});

describe('multiview copy', () => {
  const BANNED = /\b(free|premium|vip|cancel|subscription|provider|seller|reseller|sports? league|ppv)\b/i;

  it('is neutral, and calls a tile a window', () => {
    const all: string[] = [];
    for (const v of Object.values(MULTIVIEW_COPY)) if (typeof v === 'string') all.push(v);
    for (const s of all) expect(s, s).not.toMatch(BANNED);
    expect(MULTIVIEW_COPY.closeWindow).toBe('Close window');
    expect(MULTIVIEW_COPY.addChannel).toBe('Add channel');
  });

  it('offers to watch a cut window instead, and says why a window stopped', () => {
    expect(MULTIVIEW_COPY.watchInstead).toBe('Watch this one instead');
    expect(MULTIVIEW_COPY.stoppedForOther).toBe('Stopped so another window can play.');
  });

  it('the four connection-limit explanations are one text', () => {
    expect(MULTIVIEW_COPY.limit).toBe('Each window uses one connection from your source.');
    expect(Object.keys(MULTIVIEW_COPY).filter((k) => /^(infoUnknown|infoReported|kicked|learned)$/.test(k))).toEqual([]);
  });

  it('says why Add channel is off: the device or the Max windows setting, within 70 characters', () => {
    expect(MULTIVIEW_COPY.device(2)).toBe('This device can play 2 at once.');
    expect(MULTIVIEW_COPY.setting(3)).toBe('Max windows is set to 3 in Settings.');
    for (const s of [MULTIVIEW_COPY.device(6), MULTIVIEW_COPY.setting(6)]) expect(s.length).toBeLessThanOrEqual(70);
  });
});

describe('Your countries copy', () => {
  const BANNED = /\b(free|premium|vip|cancel|subscription|provider|seller|reseller|sports? league|ppv)\b/i;
  const all = (): string[] => {
    const out: string[] = [];
    for (const v of Object.values(COUNTRIES_COPY)) if (typeof v === 'string') out.push(v);
    out.push(COUNTRIES_COPY.otherCountries(40), COUNTRIES_COPY.countries(41), COUNTRIES_COPY.showing(2), COUNTRIES_COPY.firstSub(41),
      COUNTRIES_COPY.languageLine('Swedish'), COUNTRIES_COPY.folders(24));
    return out;
  };

  it('is neutral', () => {
    for (const s of all()) expect(s, s).not.toMatch(BANNED);
  });

  it('matches the spec word for word', () => {
    expect(COUNTRIES_COPY.page).toBe('Your countries');
    expect(COUNTRIES_COPY.cap).toBe('You can pick up to 10 countries.');
    expect(COUNTRIES_COPY.stale).toBe('None of your countries are in this source. Showing all folders.');
    expect(COUNTRIES_COPY.combineOff).toBe('Movie and series categories now stay per country.');
    expect(COUNTRIES_COPY.combineOn).toBe('Not sorted by country while categories are combined.');
    expect(COUNTRIES_COPY.none).toBe("This source doesn't sort its folders by country.");
    expect(COUNTRIES_COPY.loadError).toBe("Couldn't load your countries · Try again");
    expect(COUNTRIES_COPY.otherCountries(40)).toBe('Other countries (40)');
    expect(COUNTRIES_COPY.countries(41)).toBe('Countries (41)');
    expect(COUNTRIES_COPY.showing(2)).toBe('Showing 2 countries · Change');
    expect(COUNTRIES_COPY.showing(1)).toBe('Showing 1 country · Change');
    expect(COUNTRIES_COPY.firstSub(41)).toBe('Folders for 41 countries found. Pick one or more.');
    expect('firstFoot' in COUNTRIES_COPY).toBe(false);
    expect(COUNTRIES_COPY.languageLine('Swedish')).toBe('Audio and subtitles: Swedish first');
    expect(COUNTRIES_COPY.folders(1)).toBe('1 folder');
    expect(COUNTRIES_COPY.folders(31)).toBe('31 folders');
    expect(COUNTRIES_COPY.choose).toBe('Choose your countries…');
  });
});

describe('lazy screen copy', () => {
  it('says what failed and offers one action, in neutral words', () => {
    expect(LAZY_COPY.failed).toBe("Couldn't open this screen.");
    expect(LAZY_COPY.retry).toBe('Try again');
  });
});

describe('every string in copy.ts follows the copy rules', () => {
  it('has no violations outside the named exceptions', () => {
    const entries = Object.entries(COPY).flatMap(([name, value]) => collectCopy(value, name));
    expect(copyViolations(entries, COPY_EXCEPTIONS)).toEqual([]);
  });
  it('every named exception still points at a string (no stale exceptions)', () => {
    const paths = new Set(Object.entries(COPY).flatMap(([name, value]) => collectCopy(value, name)).map((e) => e.path));
    for (const p of Object.keys(COPY_EXCEPTIONS)) expect(paths.has(p), p).toBe(true);
  });
});

const SRC = dirname(fileURLToPath(import.meta.url));
const stringFree = (files: readonly string[]) => {
  const counts = scanTokens(SRC);
  return files.filter((f) => (counts[f]?.string ?? 0) > 0).map((f) => `${f}: ${counts[f]!.string}`);
};

const LIVE_FILES = [
  'screens/live/liveMenu.tsx', 'screens/live/liveLogic.ts', 'screens/live/LiveTv.tsx', 'screens/homeMenuLogic.ts', 'screens/homeLogic.ts',
  'screens/guideLogic.ts', 'screens/Player.tsx', 'screens/playerLogic.ts', 'screens/startLogic.ts', 'screens/startActions.tsx',
  'screens/matchesGridLogic.ts', 'screens/Search.tsx', 'screens/searchLogic.ts', 'screens/multiview/Multiview.tsx',
  'screens/multiview/MultiviewPicker.tsx', 'screens/multiview/mvLogic.ts', 'components/countryGridLogic.ts', 'components/foldPickerLogic.ts',
  'components/wideTileLogic.ts', 'components/ChannelList.tsx', 'components/Keyboard.tsx', 'components/TextField.tsx', 'state/events.ts',
  'state/cooldownLogic.ts', 'playback/failureText.ts', 'playback/streamInfo.ts', 'playback/mediaBadges.ts', 'playback/sourceLogic.ts',
  'playback/deviceWindows.ts', 'playback/devResume.ts', 'playback/tileFailure.ts', 'shell/railLogic.ts', 'shell/InitError.tsx', 'App.tsx',
  'screens/playerBanner.tsx',
] as const;

const SETTINGS_FILES = [
  'screens/settingsLogic.ts', 'screens/AddSource.tsx', 'screens/journalLogic.ts', 'screens/settings/ChannelsPage.tsx',
  'screens/settings/backupLogic.ts', 'screens/settings/SourcesPage.tsx', 'screens/addSourceLogic.ts', 'screens/settings/PlaybackPage.tsx',
  'screens/pairingLogic.ts', 'screens/settings/StoragePage.tsx', 'screens/settings/ManageOnPhonePage.tsx', 'screens/settings/DiagnosticsPage.tsx',
  'screens/settings/PlaybackLogView.tsx', 'screens/settings/GuidePage.tsx', 'screens/settings/ConnectionsView.tsx', 'screens/settings/AboutPage.tsx',
  'screens/settings/connectionsLogic.ts', 'screens/settings/DisplayPage.tsx', 'screens/settings/shared.ts', 'screens/Settings.tsx',
  'screens/Placeholder.tsx', 'screens/Countries.tsx', 'screens/countriesModel.ts',
] as const;

describe('copy lives in copy.ts (spec 2026-10-26 §1.4)', () => {
  it('Live TV, guide, player, multiview and shell files have no inline UI strings', () => {
    expect(stringFree(LIVE_FILES)).toEqual([]);
  });
  it('Movies, Series and VOD player files have no inline UI strings', () => {
    expect(stringFree([
      'screens/VodPlay.tsx', 'vod/subtitleLogic.ts', 'vod/kindCopy.ts', 'screens/MovieDetail.tsx', 'screens/SeriesDetail.tsx',
      'vod/posterMenuLogic.ts', 'vod/seriesDetailLogic.ts', 'vod/tracks.ts', 'screens/VodBrowse.tsx', 'screens/VodGrid.tsx', 'vod/gridLogic.ts',
      'vod/versionsLogic.ts', 'vod/vodPlayerLogic.ts', 'vod/categoryPicker.ts', 'net/trendingConfig.ts', 'vod/catchupLogic.ts',
      'vod/favToggle.ts', 'vod/launch.ts', 'vod/tabLogic.ts',
    ])).toEqual([]);
  });
  it('Settings, Add source, pairing, backup and Countries files have no inline UI strings', () => {
    expect(stringFree(SETTINGS_FILES)).toEqual([]);
  });
  it('no file anywhere has an inline UI string (the string baseline is zero)', () => {
    const left = Object.entries(scanTokens(SRC))
      .filter(([f, c]) => (c.string ?? 0) > 0 && f !== 'worker.ts') // worker.ts: phase 0 owns it; cleared after phase 0b merges
      .map(([f, c]) => `${f}: ${c.string}`);
    expect(left).toEqual([]);
  });
});
