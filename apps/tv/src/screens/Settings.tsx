import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { Match, Switch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Dialog } from '../components/Dialog.tsx';
import { Sheet, SheetRowView } from '../components/Sheet.tsx';
import { SHEET_PITCH, fromOptionItem, type OptionItem } from '../components/sheetLogic.ts';
import { COMMON_COPY } from '../copy.ts';
import { PointerFocusContext, pointerMode, usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { BOTTOM_ROW_Y } from '../shell/logic.ts';
import { Rail } from '../shell/Rail.tsx';
import { railBelow, type RailId } from '../shell/railLogic.ts';
import { goRailFrom } from '../shell/railNav.ts';
import { router, type ScreenEntry } from '../shell/router.ts';
import { drawnFocus } from '../shell/focusStyle.ts';
import { COLORS, LAYOUT, RADIUS, STRONG, TYPE } from '../shell/theme.ts';
import { CountriesPage } from './settings/CountriesPage.tsx';
import { AboutPage } from './settings/AboutPage.tsx';
import { ChannelsPage } from './settings/ChannelsPage.tsx';
import { DiagnosticsPage } from './settings/DiagnosticsPage.tsx';
import { DisplayPage } from './settings/DisplayPage.tsx';
import { GuidePage } from './settings/GuidePage.tsx';
import { ManageOnPhonePage } from './settings/ManageOnPhonePage.tsx';
import { PlaybackPage } from './settings/PlaybackPage.tsx';
import { consumeSubscreenLeave, type ConfirmOptions, type PageProps } from './settings/shared.ts';
import { SourcesPage } from './settings/SourcesPage.tsx';
import { StoragePage } from './settings/StoragePage.tsx';
import { SETTINGS_PAGES, settingsOpenAt } from './settingsLogic.ts';

/** The menu sits at the rail's content edge; its rows are Sheet rows: 72 high, 80 apart. */
const MENU_X = LAYOUT.contentX;
const MENU_Y = LAYOUT.safeY + 72;
const MENU_W = 400;
const MENU_ROW_H = SHEET_PITCH;
/** The page: right of the menu (x 608) to the right safe edge, its rows level with the menu's. */
const PAGE_X = MENU_X + MENU_W + LAYOUT.gap * 2;
const PAGE_W = LAYOUT.width - LAYOUT.safeX - PAGE_X;
const PAGE_Y = MENU_Y;
/** The page runs to the safe bottom; in pointer mode it stops a gap above the shell's bottom button row. */
const pageHeight = () => (pointerMode() ? BOTTOM_ROW_Y - LAYOUT.gap : LAYOUT.height - LAYOUT.safeY) - PAGE_Y;
const DIALOG_ID = 'settingsConfirm';
const CHOOSER_ID = 'settingsChooser';
const BUSY_W = 640;
const BUSY_H = 160;

/** Which page was open (and whether it had focus), across visits: Edit/Add source return here. */
const memory = { page: 0, area: 'menu' as 'menu' | 'page' };

function Menu(props: {
  ref: (el: ElementNode) => void; selected: number; onSelect: (i: number) => void; onEnter: () => boolean;
  /** Left: to the rail. */
  onLeft: () => boolean;
  /** Pointer click on page `i`: open it, the same as Ok. */
  onClickRow: (i: number) => void;
}) {
  const [focused, setFocused] = createSignal(false);
  const [hover, setHover] = createSignal<number | undefined>(undefined);
  let node: ElementNode | undefined;
  const move = (d: number) => {
    const next = Math.max(0, Math.min(SETTINGS_PAGES.length - 1, props.selected + d));
    if (next !== props.selected) props.onSelect(next);
    return true;
  };
  usePointerTarget({
    node: () => node,
    onHover: (p) => setHover(p ? rowAt(p.y, 0, MENU_ROW_H, SETTINGS_PAGES.length) : undefined),
    onClick: (p) => {
      const i = rowAt(p.y, 0, MENU_ROW_H, SETTINGS_PAGES.length);
      if (i !== undefined) props.onClickRow(i);
    },
    onWheel: (dy) => {
      if (dy !== 0) move(dy);
      return true;
    },
  });
  return (
    <View ref={(el) => { node = el; props.ref(el); }} x={MENU_X} y={MENU_Y} width={MENU_W} height={SETTINGS_PAGES.length * MENU_ROW_H}
      onFocusChanged={setFocused} onUp={() => move(-1)} onDown={() => move(1)}
      onRight={() => props.onEnter()} onEnter={() => props.onEnter()} onLeft={() => props.onLeft()}>
      <For each={SETTINGS_PAGES}>{(p, i) => {
        const isSel = () => i() === props.selected;
        const lit = () => drawnFocus(focused() ? props.selected : undefined, hover(), pointerMode()) === i();
        return <SheetRowView y={i() * MENU_ROW_H} width={MENU_W} row={{ id: p.id, label: p.title, checked: isSel() && !focused() }} lit={lit()} />;
      }}</For>
    </View>
  );
}

/**
 * Settings: the rail, a left menu of ten pages, the selected page on the right. Up/Down pick a page, Right/Ok enter
 * it, Left/Back return to the menu, Left on the menu goes to the rail, Back on the menu leaves. Pages share the confirm
 * dialog, the action menu and the busy panel owned here (each a Back layer through `router.pushOverlay`, except busy,
 * which ignores Back).
 */
export function SettingsScreen(props: { entry?: ScreenEntry }) {
  /** What is under Settings, for the rail (a tab's screen, the library grid over one, or unknown: a tab choice only pops). */
  const below = railBelow(router.below(1), router.below(2));
  /** A deep link opens its page focused (Back from it leaves Settings); otherwise the page remembered last. */
  const open = settingsOpenAt(props.entry?.params, memory.page);
  const [page, setPage] = createSignal(open.page);
  const [area, setArea] = createSignal<'menu' | 'page'>('menu');
  const [dialog, setDialog] = createSignal<{ message: string; yes: string; opts?: ConfirmOptions; answer: (yes: boolean) => void } | undefined>();
  const [chooser, setChooser] = createSignal<{ title: string; items: OptionItem[]; initial?: number; answer: (id?: string) => void } | undefined>();
  const [busyText, setBusyText] = createSignal<string | undefined>(undefined);

  let menuNode: ElementNode | undefined;
  let railNode: ElementNode | undefined;
  let pageNode: ElementNode | undefined;
  let chooserNode: ElementNode | undefined;
  let busyNode: ElementNode | undefined;
  let removeLayer: (() => void) | undefined;
  let alive = true;

  const focusMenu = () => {
    setArea('menu');
    memory.area = 'menu';
    menuNode?.setFocus();
    return true;
  };
  const focusPage = () => {
    if (!pageNode) return true; // nothing to focus (About)
    setArea('page');
    memory.area = 'page';
    pageNode.setFocus();
    return true;
  };
  /** After a modal closes or a page appears: focus the busy panel, the menu or the page. */
  const restoreFocus = () => queueMicrotask(() => {
    if (!alive) return;
    if (busyText() !== undefined) busyNode?.setFocus();
    else if (dialog() || chooser()) return;
    else if (area() === 'page' && pageNode) pageNode.setFocus();
    // A deep-linked page registers its node as it renders: keep the page area until it does.
    else if (area() === 'page' && open.direct) return;
    else focusMenu();
  });

  const toRail = () => {
    if (busyText() === undefined) railNode?.setFocus();
    return true;
  };
  /** A tab leaves Settings like Back from the menu does; Settings itself returns to the menu or page. */
  const onRailSelect = (id: RailId) => {
    if (id === 'settings') { restoreFocus(); return; }
    memory.area = 'menu';
    goRailFrom('settings', below, id, () => router.back({ fromVod: true }));
  };

  const selectPage = (i: number) => {
    pageNode = undefined;
    memory.page = i;
    setPage(i);
  };

  /** A click on a menu entry opens its page, the same as Ok; a page with nothing to focus (About) leaves focus on the menu. */
  const clickMenu = (i: number) => {
    if (busyText() !== undefined) return;
    if (i !== page()) selectPage(i);
    // The new page registers its node while it renders: focus it after this update.
    queueMicrotask(() => {
      if (!alive) return;
      if (pageNode) focusPage();
      else focusMenu();
    });
  };
  /** A click that focuses the page's list (or Manage on phone's actions) goes through `focusPage`, so Back returns to the menu. */
  const focusFromPointer = (node: ElementNode) => {
    if (node === pageNode) focusPage();
    else node.setFocus();
  };

  const pageProps = (): PageProps => ({
    x: PAGE_X, y: PAGE_Y, width: PAGE_W, height: pageHeight(),
    register: (el) => {
      if (!el) return;
      pageNode = el;
      // Returning from Edit/Add source: the page had focus.
      if (area() === 'page' && dialog() === undefined && chooser() === undefined) restoreFocus();
    },
    onLeftEdge: focusMenu,
    ...(open.focusItem !== undefined && page() === open.page ? { focusItem: open.focusItem } : {}),
    confirm: (message, yes, opts) => new Promise<boolean>((resolve) => {
      const answer = (ok: boolean) => {
        removeLayer?.();
        removeLayer = undefined;
        setDialog(undefined);
        restoreFocus();
        resolve(ok);
      };
      setDialog({ message, yes, answer, ...(opts ? { opts } : {}) });
      removeLayer = router.pushOverlay(DIALOG_ID, () => { removeLayer = undefined; setDialog(undefined); restoreFocus(); resolve(false); });
    }),
    choose: (title, items, initial) => new Promise<string | undefined>((resolve) => {
      const answer = (id?: string) => {
        removeLayer?.();
        removeLayer = undefined;
        setChooser(undefined);
        restoreFocus();
        resolve(id === 'cancel' ? undefined : id);
      };
      setChooser({ title, items, answer, ...(initial !== undefined ? { initial } : {}) });
      removeLayer = router.pushOverlay(CHOOSER_ID, () => { removeLayer = undefined; setChooser(undefined); restoreFocus(); resolve(undefined); });
      queueMicrotask(() => chooserNode?.setFocus());
    }),
    busy: (text) => {
      setBusyText(text);
      queueMicrotask(() => busyNode?.setFocus());
      return () => {
        setBusyText(undefined);
        restoreFocus();
      };
    },
  });

  onMount(() => {
    if (open.direct || memory.area === 'page') setArea('page');
    restoreFocus();
  });
  onCleanup(() => {
    alive = false;
    if (!consumeSubscreenLeave()) memory.area = 'menu';
    removeLayer?.();
    router.removeOverlay(DIALOG_ID);
    router.removeOverlay(CHOOSER_ID);
  });

  const onBack = () => {
    if (router.topOverlay() !== undefined) return false; // the shell closes the top layer first
    if (busyText() !== undefined) return true;
    if (area() === 'page') {
      // Opened at this page from elsewhere ("Choose your countries…", first run's "Change"): Back returns there.
      if (open.direct && page() === open.page) { memory.area = 'menu'; return false; }
      return focusMenu();
    }
    memory.area = 'menu';
    return false; // leave Settings
  };

  const id = () => SETTINGS_PAGES[page()]?.id;
  const title = () => SETTINGS_PAGES[page()]?.title ?? '';

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={onBack}
      forwardFocus={() => { restoreFocus(); return true; }}>
      <Rail ref={(el) => { railNode = el; }} active="settings" onSelect={onRailSelect}
        onRight={() => { restoreFocus(); return true; }} />
      <Text x={MENU_X} y={LAYOUT.safeY} fontSize={TYPE.title} color={COLORS.text}>{'Settings'}</Text>
      <Menu ref={(el) => { menuNode = el; }} selected={page()} onSelect={selectPage} onEnter={focusPage} onLeft={toRail}
        onClickRow={clickMenu} />
      <Text x={PAGE_X + 28} y={LAYOUT.safeY + TYPE.title - TYPE.body - 2} fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{title()}</Text>
      <PointerFocusContext.Provider value={focusFromPointer}>
      <Switch>
        <Match when={id() === 'countries'}><CountriesPage {...pageProps()} /></Match>
        <Match when={id() === 'sources'}><SourcesPage {...pageProps()} /></Match>
        <Match when={id() === 'phone'}><ManageOnPhonePage {...pageProps()} /></Match>
        <Match when={id() === 'guide'}><GuidePage {...pageProps()} /></Match>
        <Match when={id() === 'playback'}><PlaybackPage {...pageProps()} /></Match>
        <Match when={id() === 'channels'}><ChannelsPage {...pageProps()} /></Match>
        <Match when={id() === 'display'}><DisplayPage {...pageProps()} /></Match>
        <Match when={id() === 'storage'}><StoragePage {...pageProps()} /></Match>
        <Match when={id() === 'diagnostics'}><DiagnosticsPage {...pageProps()} /></Match>
        <Match when={id() === 'about'}><AboutPage {...pageProps()} /></Match>
      </Switch>
      </PointerFocusContext.Provider>

      <Show when={chooser()}>{(c) => {
        const rows = createMemo(() => c().items.map(fromOptionItem));
        return (
          <Sheet ref={(el) => { chooserNode = el; }} title={c().title} rows={rows()} initial={c().initial}
            onSelect={(r) => c().answer(r.id)} scrim={false} swallow="player" zIndex={40} />
        );
      }}</Show>
      <Show when={dialog()}>{(d) => (
        <Dialog title={d().message} line={d().opts?.line} yes={d().yes} no={d().opts?.single ? null : COMMON_COPY.cancel}
          detail={d().opts?.detail} onYes={() => d().answer(true)} onNo={() => d().answer(false)} />
      )}</Show>
      <Show when={busyText()}>{(t) => {
        let scrim: ElementNode | undefined;
        // Busy ignores Back, so its backdrop swallows clicks and does nothing.
        usePointerBackdrop(() => scrim, () => undefined);
        return (
          <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
            <View ref={(el) => { busyNode = el; }} x={(LAYOUT.width - BUSY_W) / 2} y={(LAYOUT.height - BUSY_H) / 2}
              width={BUSY_W} height={BUSY_H} color={COLORS.surface} borderRadius={RADIUS.card}
              onUp={() => true} onDown={() => true} onLeft={() => true} onRight={() => true} onEnter={() => true}
              onBack={() => true}>
              <Text y={(BUSY_H - TYPE.body) / 2 - 4} width={BUSY_W} maxWidth={BUSY_W} contain="width" textAlign="center"
                fontSize={TYPE.body} {...STRONG} color={COLORS.text}>{t()}</Text>
            </View>
          </View>
        );
      }}</Show>
    </View>
  );
}
