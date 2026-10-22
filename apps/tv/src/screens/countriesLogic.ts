import type { CountriesPatch, CountryChoices } from '@iptv/app-api';
// Type-only: the settings shapes.
import type { RegionSettings } from '@iptv/core';
import { COUNTRIES_COPY } from '../copy.ts';
import { createDebounce } from '../playback/debounce.ts';

/**
 * Your countries (spec 2026-10-22-your-countries-flags): the Settings page's and the first-run step's rules. Pure
 * except for timers (`loadChoices`, `createCountrySaver`). Unit-tested.
 */

export type OtherFolders = 'fold' | 'below' | 'hidden';
export const OTHER_FOLDERS: readonly OtherFolders[] = ['fold', 'below', 'hidden'];

/** "Other countries' folders" as the settings hold it: Hidden is `only`; otherwise the fold setting decides. */
export function otherFoldersOf(regions: RegionSettings, foldCountries: boolean): OtherFolders {
  if (regions.mode === 'only') return 'hidden';
  return foldCountries ? 'fold' : 'below';
}

export const otherFoldersLabel = (v: OtherFolders): string =>
  (v === 'fold' ? COUNTRIES_COPY.fold : v === 'below' ? COUNTRIES_COPY.below : COUNTRIES_COPY.hidden);

/** In one folder: first + fold; Below yours: first, no fold; Hidden: only (fold ignored). */
export function otherFoldersPatch(v: OtherFolders): CountriesPatch {
  if (v === 'hidden') return { mode: 'only' };
  return { mode: 'first', foldCountries: v === 'fold' };
}

/** A flag press: the new codes; Hidden stays Hidden, anything else (off after "Show all folders as before") goes first. */
export function pickPatch(codes: readonly string[], regions: RegionSettings): CountriesPatch {
  return { codes: [...codes], mode: regions.mode === 'only' ? 'only' : 'first' };
}

/** "Show all folders as before": the rule off, the picks kept (pressing a flag restores them). */
export const RESET_PATCH: CountriesPatch = { mode: 'off' };
/** First run's Skip (and Back): nothing picked, the rule off. */
export const SKIP_PATCH: CountriesPatch = { codes: [], mode: 'off' };

/** The grid's state right after a press, before the worker answers. */
export function applyPatch(c: CountryChoices, p: CountriesPatch): CountryChoices {
  return {
    ...c,
    regions: { codes: p.codes ? [...p.codes] : c.regions.codes, mode: p.mode ?? c.regions.mode },
    foldCountries: p.foldCountries ?? c.foldCountries,
  };
}

/** A grid needs two or more countries; with fewer the page says so and first run skips the step. */
export const hasGrid = (c: CountryChoices): boolean => c.choices.length >= 2;

/** The notices above the grid, for the latest answer (`prev`: the answer before it). */
export function notices(next: CountryChoices, prev?: CountryChoices): string[] {
  if (!hasGrid(next)) return [COUNTRIES_COPY.none];
  const out: string[] = [];
  if (next.stale) out.push(COUNTRIES_COPY.stale);
  const picksOn = next.regions.codes.length > 0 && next.regions.mode !== 'off';
  if (prev?.combineCategories && !next.combineCategories) out.push(COUNTRIES_COPY.combineOff);
  else if (next.combineCategories && picksOn) out.push(COUNTRIES_COPY.combineOn);
  return out;
}

/** How long the grid waits for the worker (busy with a guide refresh) before "Couldn't load your countries". */
export const CHOICES_TIMEOUT_MS = 2000;

/** `get()`'s answer, or undefined on a failure or after `timeoutMs`. */
export async function loadChoices(get: () => Promise<CountryChoices>, timeoutMs = CHOICES_TIMEOUT_MS): Promise<CountryChoices | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      get(),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fast presses on the remote send one write. */
export const SAVE_DEBOUNCE_MS = 300;

export interface CountrySaver {
  /** Merges `patch` into the pending write and (re)starts the 300 ms wait. */
  save(patch: CountriesPatch): void;
  /** Sends the pending write now (leaving the page, Done). */
  flush(): void;
  /** Drops the pending write and ignores the answer of one in flight (Skip). */
  cancel(): void;
  /** A write is waiting or in flight. */
  busy(): boolean;
}

/** Debounced `setCountries`: one write per burst; only the last write's answer counts, and only once nothing newer waits. */
export function createCountrySaver(
  send: (patch: CountriesPatch) => Promise<CountryChoices>, onSaved: (c: CountryChoices) => void, onError: () => void,
  ms = SAVE_DEBOUNCE_MS,
): CountrySaver {
  let pending: CountriesPatch | undefined;
  let seq = 0;
  let settled = 0;
  const fire = () => {
    const patch = pending;
    pending = undefined;
    if (!patch) return;
    const mine = ++seq;
    // An answer older than a later write is dropped; so is one that arrives while presses wait unsent (adopting it
    // would erase them). The last write's answer, with nothing pending, is the server's truth and is adopted.
    send(patch).then(
      (c) => { if (mine === seq) { settled = mine; if (!pending) onSaved(c); } },
      () => { if (mine === seq) { settled = mine; onError(); } },
    );
  };
  const timer = createDebounce<void>(ms, fire);
  return {
    save(patch) {
      pending = { ...pending, ...patch };
      timer.schedule(undefined);
    },
    flush() {
      timer.cancel();
      fire();
    },
    cancel() {
      timer.cancel();
      pending = undefined;
      seq++;
      settled = seq;
    },
    busy: () => pending !== undefined || settled !== seq,
  };
}

/** A `getCountryChoices` result applies only if it is the newest load and no save is pending or in flight. */
export const loadApplies = (mine: number, latest: number, saving: boolean): boolean => mine === latest && !saving;

/** After the first source: the countries step with two or more choices, else Home as before. */
export function firstRunTarget(c: CountryChoices | undefined): 'countries' | 'home' {
  return c !== undefined && hasGrid(c) ? 'countries' : 'home';
}

/** First run: this TV's country, picked and saved as the screen opens, when nothing is picked yet. */
export function preselect(c: CountryChoices): string[] | undefined {
  return c.deviceCountry !== undefined && c.regions.codes.length === 0 ? [c.deviceCountry] : undefined;
}

/** Preselect only once per first run: false once it ran (the screen remounts after "Change"). */
export const shouldPreselect = (alreadyRan: boolean): boolean => !alreadyRan;

/** Where Down from the grid goes: always Done; Change stays reachable with Up from Done or Skip. */
export const belowGridTarget = (): 'done' => 'done';

/** With a country already picked, one press (Done) finishes. */
export const firstRunFocus = (codes: readonly string[]): 'done' | 'grid' => (codes.length > 0 ? 'done' : 'grid');

/**
 * Done's preferred languages: each pick's languages in pick order (`countryLanguages`; `lang:xx` is xx), then the TV's
 * language, deduplicated, only languages the setting knows (`allowed`), at most 5 (core's `PREFERRED_LANGUAGES_MAX`).
 */
export function firstRunLanguages(
  picks: readonly string[], tvLanguage: string | undefined, langsOf: (code: string) => string[], allowed: readonly string[],
): string[] {
  const out: string[] = [];
  const add = (l: string) => { if (allowed.includes(l) && !out.includes(l) && out.length < 5) out.push(l); };
  for (const k of picks) for (const l of k.startsWith('lang:') ? [k.slice(5)] : langsOf(k)) add(l);
  const tv = tvLanguage?.split(/[-_]/)[0]?.toLowerCase();
  if (tv) add(tv);
  return out;
}

/** "Audio and subtitles: Swedish first"; undefined with no language to name. */
export function languageLine(langs: readonly string[], nameOf: (code: string) => string | undefined): string | undefined {
  const first = langs[0];
  return first === undefined ? undefined : COUNTRIES_COPY.languageLine(nameOf(first) ?? first.toUpperCase());
}
