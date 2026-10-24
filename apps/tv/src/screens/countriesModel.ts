import { createSignal } from 'solid-js';
import type { CountriesPatch, CountryChoices } from '@iptv/app-api';
import { api } from '../api.ts';
import { togglePick } from '../components/countryGridLogic.ts';
import { COUNTRIES_COPY } from '../copy.ts';
import { showToast } from '../shell/Toast.tsx';
import { patchSettings, settings } from '../state/appState.ts';
import { applyPatch, createCountrySaver, loadApplies, loadChoices, notices as noticesOf, pickPatch } from './countriesLogic.ts';

export interface CountriesModel {
  /** The grid's data: the latest answer with the presses since applied. Undefined until the first load succeeds; a failed reload keeps the last answer. */
  choices: () => CountryChoices | undefined;
  /** The last load failed or took longer than 2 s. */
  failed: () => boolean;
  notices: () => string[];
  codes: () => readonly string[];
  load: () => Promise<void>;
  /** OK on a chip: pick or un-pick (the 11th pick only shows the cap message). */
  toggle: (key: string) => void;
  apply: (patch: CountriesPatch) => void;
  flush: () => void;
  cancel: () => void;
}

/**
 * Your countries' state for the Settings page and the first-run screen: one `getCountryChoices` read, presses applied
 * at once and saved debounced; each answer also updates the app's settings, so Live TV and the pickers follow.
 */
export function createCountriesModel(): CountriesModel {
  const [choices, setChoices] = createSignal<CountryChoices | undefined>(undefined);
  const [failed, setFailed] = createSignal(false);
  const [saved, setSaved] = createSignal<CountryChoices | undefined>(undefined);
  const [before, setBefore] = createSignal<CountryChoices | undefined>(undefined);

  const adopt = (c: CountryChoices) => {
    setBefore(saved());
    setSaved(c);
    setChoices(c);
    const s = settings();
    if (s) patchSettings({ ...s, regions: c.regions, foldCountries: c.foldCountries, combineCategories: c.combineCategories });
  };
  let loadToken = 0;
  const load = async () => {
    const mine = ++loadToken;
    setFailed(false);
    const c = await loadChoices(() => api.getCountryChoices());
    if (!loadApplies(mine, loadToken, saver.busy())) return;
    if (!c) { setFailed(true); return; }
    setBefore(undefined);
    setSaved(c);
    setChoices(c);
  };
  const saver = createCountrySaver((p) => api.setCountries(p), adopt, () => {
    showToast(COUNTRIES_COPY.saveError);
    void load();
  });
  const apply = (patch: CountriesPatch) => {
    const c = choices();
    if (c) setChoices(applyPatch(c, patch));
    saver.save(patch);
  };
  const toggle = (key: string) => {
    const c = choices();
    if (!c) return;
    const r = togglePick(c.regions.codes, key);
    if (r.capped) { showToast(COUNTRIES_COPY.cap); return; }
    apply(pickPatch(r.codes, c.regions));
  };
  return {
    choices, failed, load, toggle, apply,
    notices: () => { const s = saved(); return s ? noticesOf(s, before()) : []; },
    codes: () => choices()?.regions.codes ?? [],
    flush: () => saver.flush(),
    cancel: () => saver.cancel(),
  };
}
