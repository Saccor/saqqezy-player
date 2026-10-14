import { For, Text, View } from '@lightningtv/solid';
import { createSignal } from 'solid-js';
import { Row } from '@lightningtv/solid/primitives';
import { router, type ScreenEntry, type ScreenId } from '../shell/router.ts';
import { COLORS, FONT, LAYOUT } from '../shell/theme.ts';

const TITLES: Record<ScreenId, string> = {
  addSource: 'Add source',
  home: 'Home',
  player: 'Player',
  guide: 'TV guide',
  search: 'Search',
  settings: 'Settings',
};

/** Screens Home can open while they are placeholders (Tasks 6 to 11 replace them). */
const HOME_LINKS: ScreenId[] = ['guide', 'search', 'settings', 'player', 'addSource'];

const BTN_W = 220;
const BTN_H = 80;

function LinkButton(props: { target: ScreenId }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View width={BTN_W} height={BTN_H} borderRadius={LAYOUT.radius} onFocusChanged={setFocused}
      color={focused() ? COLORS.focus : COLORS.background} scale={focused() ? 1.05 : 1}
      onEnter={() => { router.push(props.target); return true; }}>
      <Text y={(BTN_H - FONT.body) / 2 - 4} width={BTN_W} maxWidth={BTN_W} contain="width" textAlign="center"
        fontSize={FONT.body} color={focused() ? COLORS.onFocus : COLORS.text}>{TITLES[props.target]}</Text>
    </View>
  );
}

/** A titled panel naming the screen; stands in until the real screen lands. */
export function PlaceholderScreen(props: { entry: ScreenEntry }) {
  const screen = props.entry.screen;
  const isHome = screen === 'home';
  const isRoot = router.depth() <= 1;
  const params = Object.entries(props.entry.params).map(([k, v]) => `${k}=${String(v)}`).join(', ');
  const panelW = LAYOUT.width - LAYOUT.safeX * 2;
  const rowW = HOME_LINKS.length * (BTN_W + LAYOUT.gap) - LAYOUT.gap;

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={screen === 'player' ? 0x00000000 : COLORS.background}>
      <View x={LAYOUT.safeX} y={160} width={panelW} height={460} color={COLORS.surface}
        borderRadius={LAYOUT.radius * 2} forwardFocus={0}>
        {isHome
          ? (
            <Row x={48} y={300} width={rowW} height={BTN_H} gap={LAYOUT.gap} scroll="none" autofocus>
              <For each={HOME_LINKS}>{(t) => <LinkButton target={t} />}</For>
            </Row>
          )
          : <View x={48} y={300} width={2} height={2} autofocus />}
        <Text x={48} y={48} fontSize={FONT.title} color={COLORS.text}>{TITLES[screen]}</Text>
        <Text x={48} y={124} fontSize={FONT.body} color={COLORS.muted}>
          {`This is the ${TITLES[screen]} screen (placeholder).`}
        </Text>
        <Text x={48} y={172} fontSize={FONT.small} color={COLORS.muted}>
          {`${params ? `Params: ${params}. ` : ''}${isHome ? 'Ok opens a screen. ' : ''}${isRoot ? 'Back asks to exit.' : 'Back returns.'}`}
        </Text>
      </View>
    </View>
  );
}
