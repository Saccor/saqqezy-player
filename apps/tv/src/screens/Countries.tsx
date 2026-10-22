import { Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { onCleanup, onMount, createSignal } from 'solid-js';
import { countryLanguages } from '@iptv/core';
import { api } from '../api.ts';
import { flagFor } from '../assets/flags/index.ts';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { CountryGrid } from '../components/CountryGrid.tsx';
import { gridWidth, type GridSort } from '../components/countryGridLogic.ts';
import { COUNTRIES_COPY } from '../copy.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { COLORS, LAYOUT, STRONG, TYPE } from '../shell/theme.ts';
import { settings } from '../state/appState.ts';
import { languageName } from '../vod/tracks.ts';
import { PREFERRED_LANGUAGE_OPTIONS } from '../vod/versionsLogic.ts';
import { SKIP_PATCH, belowGridTarget, firstRunFocus, firstRunLanguages, languageLine, preselect, shouldPreselect } from './countriesLogic.ts';
import { createCountriesModel } from './countriesModel.ts';
import { saveSetting } from './settings/shared.ts';

const GRID_W = gridWidth(4);
const X = (LAYOUT.width - GRID_W) / 2;
const STEP_Y = LAYOUT.safeY;
const TITLE_Y = STEP_Y + 40;
const SUB_Y = TITLE_Y + 64;
const GRID_Y = SUB_Y + 56;
const LANG_Y = 840;
const BUTTONS_Y = 912;
const FOOT_Y = 992;
const GRID_H = LANG_Y - GRID_Y - 16;
const BUTTON_W = 240;
/** The languages "Preferred language" knows (Settings › Playback). */
const ALLOWED = PREFERRED_LANGUAGE_OPTIONS.filter((c) => c !== 'auto');
const tvLanguage = (): string | undefined => (typeof navigator === 'undefined' ? undefined : navigator.language);

/**
 * First run's one extra step (spec 2026-10-22-your-countries-flags §First run): after the first source, when its
 * folders name two or more countries. This TV's country is picked and saved as the screen opens and focus starts on
 * Done, so one press finishes. Skip (and Back: Add source is gone from the stack) turns the rule off with no picks.
 * Done also fills the preferred languages from the picks while the user has none of their own.
 */
/** The preselect of this TV's country already ran this first run (the screen remounts after "Change"). */
let preselected = false;

export function CountriesScreen(_props: { entry: ScreenEntry }) {
  const model = createCountriesModel();
  const [sort, setSort] = createSignal<GridSort>('most');
  let gridNode: ElementNode | undefined;
  let changeNode: ElementNode | undefined;
  let doneNode: ElementNode | undefined;
  let skipNode: ElementNode | undefined;
  let alive = true;
  let leaving = false;
  const c = () => model.choices();
  const langs = () => firstRunLanguages(model.codes(), tvLanguage(), countryLanguages, ALLOWED);
  /** Only while the user has no preferred languages of their own. */
  const showLanguages = () => (settings()?.preferredLanguages.length ?? 0) === 0 && langs().length > 0;

  const finish = () => {
    if (leaving) return;
    leaving = true;
    // First run is over: a later one in this app session preselects again.
    preselected = false;
    router.replace('home');
  };
  const done = () => {
    model.flush();
    if (showLanguages()) void saveSetting({ preferredLanguages: langs() });
    finish();
  };
  const skip = () => {
    model.cancel();
    void api.setCountries(SKIP_PATCH).catch((err: unknown) => {
      console.warn('Skip countries failed', err instanceof Error ? err.name : 'Error');
    });
    finish();
  };
  /** Settings › Playback at "Preferred language"; Back there returns here. */
  const change = () => router.push('settings', { page: 'playback', focusItem: 'preferredLanguage' });
  const focusStart = () => {
    (firstRunFocus(model.codes()) === 'done' ? doneNode : gridNode)?.setFocus();
    return true;
  };
  const aboveButtons = () => { (showLanguages() ? changeNode : gridNode)?.setFocus(); return true; };
  /** Down from the grid always lands on Done; Change stays reachable with Up from Done or Skip. */
  const belowGrid = () => { (belowGridTarget() === 'done' ? doneNode : gridNode)?.setFocus(); return true; };

  onMount(() => {
    void (async () => {
      await model.load();
      if (!alive) return;
      const loaded = c();
      // The worker did not answer within 2 s: never hold up the first run.
      if (!loaded) { finish(); return; }
      // Once per first run: coming back from "Change" must not re-pick a country the person cleared.
      const pre = shouldPreselect(preselected) ? preselect(loaded) : undefined;
      preselected = true;
      if (pre) {
        model.apply({ codes: pre, mode: 'first' });
        model.flush();
      }
      queueMicrotask(() => { if (alive) focusStart(); });
    })();
  });
  onCleanup(() => {
    alive = false;
    // Leaving for Settings › Playback ("Change"): save what is pending. Done and Skip already did.
    if (!leaving) model.flush();
  });

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background}
      onBack={() => { skip(); return true; }} forwardFocus={focusStart}>
      <Text x={X} y={STEP_Y} fontSize={TYPE.meta} color={COLORS.muted}>{COUNTRIES_COPY.step}</Text>
      <Text x={X} y={TITLE_Y} fontSize={TYPE.title} {...STRONG} color={COLORS.text}>{COUNTRIES_COPY.firstTitle}</Text>
      <Show when={c()}>{(x) => (
        <>
          <Text x={X} y={SUB_Y} width={GRID_W} maxWidth={GRID_W} contain="width" maxLines={1} fontSize={TYPE.body}
            color={COLORS.textSecondary}>{COUNTRIES_COPY.firstSub(x().choices.filter((ch) => !ch.isLanguage).length)}</Text>
          <CountryGrid ref={(el) => { gridNode = el; }} x={X} y={GRID_Y} width={GRID_W} height={GRID_H}
            choices={x().choices} codes={x().regions.codes} deviceCountry={x().deviceCountry} sort={sort()}
            onSort={() => setSort(sort() === 'most' ? 'az' : 'most')} onToggle={(key) => model.toggle(key)}
            onEdge={(e) => (e === 'down' ? belowGrid() : true)} flagOf={flagFor} initialKey={x().deviceCountry} />
        </>
      )}</Show>
      <Show when={showLanguages()}>
        <Text x={X} y={LANG_Y + (BUTTON_H - TYPE.body) / 2 - 4} width={GRID_W - BUTTON_W - LAYOUT.gap}
          maxWidth={GRID_W - BUTTON_W - LAYOUT.gap} contain="width" maxLines={1} fontSize={TYPE.body} color={COLORS.text}>
          {languageLine(langs(), languageName) ?? ''}
        </Text>
        <Button ref={(el) => { changeNode = el; }} x={X + GRID_W - BUTTON_W} y={LANG_Y} width={BUTTON_W} label={COUNTRIES_COPY.change}
          onPress={change} onUp={() => { gridNode?.setFocus(); return true; }} onDown={() => { doneNode?.setFocus(); return true; }} />
      </Show>
      <View x={X} y={BUTTONS_Y} width={GRID_W} height={BUTTON_H}
        onLeft={() => { doneNode?.setFocus(); return true; }} onRight={() => { skipNode?.setFocus(); return true; }}>
        <Button ref={(el) => { doneNode = el; }} width={BUTTON_W} label={COUNTRIES_COPY.done} onPress={done} onUp={aboveButtons} />
        <Button ref={(el) => { skipNode = el; }} x={BUTTON_W + LAYOUT.gap} width={BUTTON_W} label={COUNTRIES_COPY.skip}
          onPress={skip} onUp={aboveButtons} />
      </View>
      <Text x={X} y={FOOT_Y} fontSize={TYPE.meta} color={COLORS.muted}>{COUNTRIES_COPY.firstFoot}</Text>
    </View>
  );
}
