import { Show, Text, View, activeElement, type ElementNode } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { flagFor } from '../../assets/flags/index.ts';
import { CountryGrid } from '../../components/CountryGrid.tsx';
import { gridWidth, resultLine, type GridSort } from '../../components/countryGridLogic.ts';
import { SETTING_ROW_H, SettingsList, type SettingItem } from '../../components/SettingsList.tsx';
import { COUNTRIES_COPY } from '../../copy.ts';
import { COLORS, LINE, SPACE, TYPE } from '../../shell/theme.ts';
import { OTHER_FOLDERS, RESET_PATCH, hasGrid, otherFoldersLabel, otherFoldersOf, otherFoldersPatch } from '../countriesLogic.ts';
import { createCountriesModel } from '../countriesModel.ts';
import { cycleOption } from '../settingsLogic.ts';
import type { PageProps } from './shared.ts';

/** Text inset, level with the page title (Settings draws it at x + 28). */
const PAD = SPACE.l;
/** Notices (up to two lines) sit at the page top, level with the menu's first row; the grid follows them. */
const NOTICE_Y = 0;
const GRID_Y = NOTICE_Y + LINE.meta * 2 + SPACE.s;
const RESULT_H = 40;
const LIST_H = 2 * SETTING_ROW_H;

/**
 * Settings › Your countries (spec 2026-10-22-your-countries-flags): the help line, notices, the flag grid, the result
 * line, then "Other countries' folders ‹ … ›" and "Show all folders as before". Every press saves (debounced); Back
 * leaves (flushing a pending save), there is nothing to confirm. Down from the grid's last row goes to the list, Up from the list's first row back.
 */
export function CountriesPage(props: PageProps) {
  const model = createCountriesModel();
  const [sort, setSort] = createSignal<GridSort>('most');
  const [area, setArea] = createSignal<'grid' | 'list'>('grid');
  const [sel, setSel] = createSignal(0);
  let wrap: ElementNode | undefined;
  let gridNode: ElementNode | undefined;
  let listNode: ElementNode | undefined;
  let alive = true;
  const c = () => model.choices();
  const grid = () => { const x = c(); return x !== undefined && hasGrid(x); };
  const gridH = () => props.height - GRID_Y - RESULT_H - LIST_H;
  const items = (): SettingItem[] => {
    if (model.failed()) return [{ id: 'retry', label: COUNTRIES_COPY.loadError }];
    const x = c();
    if (!x || !hasGrid(x)) return [];
    return [
      { id: 'other', label: COUNTRIES_COPY.otherFolders, value: otherFoldersLabel(otherFoldersOf(x.regions, x.foldCountries)), adjustable: true },
      { id: 'reset', label: COUNTRIES_COPY.reset, disabled: x.regions.mode === 'off' },
    ];
  };
  const adjust = (id: string, dir: 1 | -1) => {
    const x = c();
    if (id !== 'other' || !x) return false;
    model.apply(otherFoldersPatch(cycleOption(OTHER_FOLDERS, otherFoldersOf(x.regions, x.foldCountries), dir)));
    return true;
  };
  /** Focus into the page: the grid (or the list when it had focus, or when there is no grid). */
  const forward = () => {
    const toList = area() === 'list' || !grid();
    const target = toList ? listNode : gridNode;
    if (target) {
      setArea(toList ? 'list' : 'grid');
      target.setFocus();
    }
    return true;
  };
  const focusGrid = () => { if (grid()) { setArea('grid'); gridNode?.setFocus(); } return true; };
  const focusList = () => { if (items().length > 0) { setArea('list'); listNode?.setFocus(); } return true; };
  const load = async () => {
    await model.load();
    // The page was entered while it loaded: hand the focus on now.
    if (alive && activeElement() === wrap) queueMicrotask(forward);
  };
  const ok = (id: string) => {
    if (id === 'other') adjust(id, 1);
    else if (id === 'reset' && c()?.regions.mode !== 'off') model.apply(RESET_PATCH);
    else if (id === 'retry') void load();
  };

  onMount(() => { void load(); });
  onCleanup(() => {
    alive = false;
    model.flush();
    props.register(undefined);
  });

  return (
    <View ref={(el) => { wrap = el; props.register(el); }} x={props.x} y={props.y} width={props.width} height={props.height}
      forwardFocus={forward} onLeft={() => props.onLeftEdge()}
      onBack={() => { model.flush(); return false; }}>
      <Text x={PAD} y={NOTICE_Y} width={props.width - PAD * 2} maxWidth={props.width - PAD * 2} contain="width" maxLines={2}
        fontSize={TYPE.meta} color={COLORS.text}>{model.notices().join(' ')}</Text>
      <Show when={grid()}>
        <CountryGrid ref={(el) => { gridNode = el; }} x={PAD} y={GRID_Y} width={gridWidth(4)} height={gridH()}
          choices={c()!.choices} codes={c()!.regions.codes} deviceCountry={c()!.deviceCountry} sort={sort()}
          onSort={() => setSort(sort() === 'most' ? 'az' : 'most')} onToggle={(key) => model.toggle(key)}
          onEdge={(e) => (e === 'down' ? focusList() : e === 'left' ? props.onLeftEdge() : true)}
          flagOf={flagFor} initialKey={c()!.deviceCountry} />
        <Text x={PAD} y={GRID_Y + gridH() + 8} width={props.width - PAD * 2} maxWidth={props.width - PAD * 2} contain="width"
          maxLines={1} fontSize={TYPE.meta} color={COLORS.textSecondary}>{resultLine(c()!)}</Text>
      </Show>
      <Show when={items().length > 0}>
        <SettingsList ref={(el) => { listNode = el; }} x={0} y={props.height - LIST_H} width={props.width} height={LIST_H}
          items={items()} selected={sel()} onSelect={setSel} onAdjust={adjust} onOk={ok}
          onLeftEdge={props.onLeftEdge} onUpEdge={focusGrid} />
      </Show>
    </View>
  );
}
