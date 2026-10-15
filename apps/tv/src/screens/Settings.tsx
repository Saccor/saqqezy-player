import { For, Show, Text, View, type ElementNode } from '@lightningtv/solid';
import { Match, Switch, createSignal, onCleanup, onMount } from 'solid-js';
import { OptionsMenu, type OptionItem } from '../components/OptionsMenu.tsx';
import { PointerFocusContext, pointerMode, usePointerBackdrop, usePointerTarget } from '../input/pointer.ts';
import { rowAt } from '../input/pointerLogic.ts';
import { ConfirmDialog } from '../shell/ConfirmDialog.tsx';
import { router } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';
import { AboutPage } from './settings/AboutPage.tsx';
import { ChannelsPage } from './settings/ChannelsPage.tsx';
import { DiagnosticsPage } from './settings/DiagnosticsPage.tsx';
import { DisplayPage } from './settings/DisplayPage.tsx';
import { GuidePage } from './settings/GuidePage.tsx';
import { ManageOnPhonePage } from './settings/ManageOnPhonePage.tsx';
import { PlaybackPage } from './settings/PlaybackPage.tsx';
import { consumeSubscreenLeave, type PageProps } from './settings/shared.ts';
import { SourcesPage } from './settings/SourcesPage.tsx';
import { StoragePage } from './settings/StoragePage.tsx';
import { SETTINGS_PAGES } from './settingsLogic.ts';

const MENU_X = LAYOUT.safeX;
const MENU_Y = 170;
const MENU_W = 400;
const MENU_ROW_H = 80;
const PAGE_X = MENU_X + MENU_W + LAYOUT.gap * 2;
const PAGE_W = LAYOUT.width - LAYOUT.safeX - PAGE_X;
const PAGE_Y = MENU_Y + 64;
const HINT_Y = LAYOUT.height - LAYOUT.safeY - 34;
const PAGE_H = HINT_Y - LAYOUT.gap - PAGE_Y;
const DIALOG_ID = 'settingsConfirm';
const CHOOSER_ID = 'settingsChooser';
const BUSY_W = 640;
const BUSY_H = 160;

/** Which page was open (and whether it had focus), across visits: Edit/Add source return here. */
const memory = { page: 0, area: 'menu' as 'menu' | 'page' };

function Menu(props: {
  ref: (el: ElementNode) => void; selected: number; onSelect: (i: number) => void; onEnter: () => boolean;
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
      onRight={() => props.onEnter()} onEnter={() => props.onEnter()} onLeft={() => true}>
      <For each={SETTINGS_PAGES}>{(p, i) => {
        const isSel = () => i() === props.selected;
        const hovered = () => pointerMode() && hover() === i();
        return (
          <View y={i() * MENU_ROW_H} width={MENU_W} height={MENU_ROW_H - 8} borderRadius={LAYOUT.radius}
            color={isSel() ? (focused() ? COLORS.focus : COLORS.surface) : hovered() ? COLORS.hover : 0x00000000}>
            <Text x={24} y={(MENU_ROW_H - 8 - FONT.body) / 2 - 3} fontSize={FONT.body}
              color={isSel() && focused() ? COLORS.onFocus : isSel() || hovered() ? COLORS.text : COLORS.muted}>{p.title}</Text>
          </View>
        );
      }}</For>
    </View>
  );
}

/**
 * Settings: a left menu of nine pages, the selected page on the right. Up/Down pick a page, Right/Ok enter
 * it, Left/Back return to the menu, Back on the menu leaves. Pages share the confirm dialog, the action menu
 * and the busy panel owned here (each a Back layer through `router.pushOverlay`, except busy, which ignores Back).
 */
export function SettingsScreen() {
  const [page, setPage] = createSignal(Math.min(memory.page, SETTINGS_PAGES.length - 1));
  const [area, setArea] = createSignal<'menu' | 'page'>('menu');
  const [dialog, setDialog] = createSignal<{ message: string; yes: string; answer: (yes: boolean) => void } | undefined>();
  const [chooser, setChooser] = createSignal<{ title: string; items: OptionItem[]; answer: (id?: string) => void } | undefined>();
  const [busyText, setBusyText] = createSignal<string | undefined>(undefined);

  let menuNode: ElementNode | undefined;
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
    else focusMenu();
  });

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
    x: PAGE_X, y: PAGE_Y, width: PAGE_W, height: PAGE_H,
    register: (el) => {
      if (!el) return;
      pageNode = el;
      // Returning from Edit/Add source: the page had focus.
      if (area() === 'page' && dialog() === undefined && chooser() === undefined) restoreFocus();
    },
    onLeftEdge: focusMenu,
    confirm: (message, yes) => new Promise<boolean>((resolve) => {
      const answer = (ok: boolean) => {
        removeLayer?.();
        removeLayer = undefined;
        setDialog(undefined);
        restoreFocus();
        resolve(ok);
      };
      setDialog({ message, yes, answer });
      removeLayer = router.pushOverlay(DIALOG_ID, () => { removeLayer = undefined; setDialog(undefined); restoreFocus(); resolve(false); });
    }),
    choose: (title, items) => new Promise<string | undefined>((resolve) => {
      const answer = (id?: string) => {
        removeLayer?.();
        removeLayer = undefined;
        setChooser(undefined);
        restoreFocus();
        resolve(id === 'cancel' ? undefined : id);
      };
      setChooser({ title, items, answer });
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
    if (memory.area === 'page') setArea('page');
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
    if (area() === 'page') return focusMenu();
    memory.area = 'menu';
    return false; // leave Settings
  };

  const id = () => SETTINGS_PAGES[page()]?.id;
  const title = () => SETTINGS_PAGES[page()]?.title ?? '';

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={COLORS.background} onBack={onBack}
      forwardFocus={() => { restoreFocus(); return true; }}>
      <Text x={LAYOUT.safeX} y={LAYOUT.safeY} fontSize={FONT.title} color={COLORS.text}>{'Settings'}</Text>
      <Menu ref={(el) => { menuNode = el; }} selected={page()} onSelect={selectPage} onEnter={focusPage} onClickRow={clickMenu} />
      <Text x={PAGE_X + 28} y={MENU_Y + 8} fontSize={FONT.heading} color={COLORS.text}>{title()}</Text>
      <PointerFocusContext.Provider value={focusFromPointer}>
      <Switch>
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
      <Text x={LAYOUT.safeX} y={HINT_Y} fontSize={FONT.small} color={COLORS.muted}>
        {area() === 'page' ? 'Ok select · Left/Right change · Back menu' : 'Up/Down choose · Ok or Right open · Back leave'}
      </Text>

      <Show when={chooser()}>{(c) => (
        <OptionsMenu ref={(el) => { chooserNode = el; }} title={c().title} items={c().items} onChoose={(cid) => c().answer(cid)} />
      )}</Show>
      <Show when={dialog()}>{(d) => (
        <ConfirmDialog message={d().message} yes={d().yes} no="Cancel" onYes={() => d().answer(true)} onNo={() => d().answer(false)} />
      )}</Show>
      <Show when={busyText()}>{(t) => {
        let scrim: ElementNode | undefined;
        // Busy ignores Back, so its backdrop swallows clicks and does nothing.
        usePointerBackdrop(() => scrim, () => undefined);
        return (
          <View ref={(el) => { scrim = el; }} width={LAYOUT.width} height={LAYOUT.height} color={COLORS.scrim} zIndex={60}>
            <View ref={(el) => { busyNode = el; }} x={(LAYOUT.width - BUSY_W) / 2} y={(LAYOUT.height - BUSY_H) / 2}
              width={BUSY_W} height={BUSY_H} color={COLORS.surface} borderRadius={LAYOUT.radius * 2}
              onUp={() => true} onDown={() => true} onLeft={() => true} onRight={() => true} onEnter={() => true}
              onBack={() => true}>
              <Text y={(BUSY_H - FONT.heading) / 2 - 4} width={BUSY_W} maxWidth={BUSY_W} contain="width" textAlign="center"
                fontSize={FONT.heading} color={COLORS.text}>{t()}</Text>
            </View>
          </View>
        );
      }}</Show>
    </View>
  );
}
