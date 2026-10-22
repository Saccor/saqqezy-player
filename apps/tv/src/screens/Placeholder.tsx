import { For, Text, View } from '@lightningtv/solid';
import { Row } from '@lightningtv/solid/primitives';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { router, type ScreenEntry, type ScreenId } from '../shell/router.ts';
import { COLORS, LAYOUT, TYPE } from '../shell/theme.ts';

const TITLES: Record<ScreenId, string> = {
  addSource: 'Add source',
  home: 'Home',
  player: 'Player',
  search: 'Search',
  settings: 'Settings',
  vod: 'Movies',
  vodGrid: 'Movies',
  movieDetail: 'Movie',
  seriesDetail: 'Series',
  vodPlay: 'Player',
  start: 'Start',
  startSports: 'Matches in your guide',
  multiview: 'Multiview',
};

/** Screens Home can open while they are placeholders (Tasks 6 to 11 replace them). */
const HOME_LINKS: ScreenId[] = ['search', 'settings', 'player', 'addSource'];

const BTN_W = 220;

function LinkButton(props: { target: ScreenId }) {
  return <Button width={BTN_W} label={TITLES[props.target]} onPress={() => router.push(props.target)} />;
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
    <View width={LAYOUT.width} height={LAYOUT.height} color={screen === 'player' ? COLORS.transparent : COLORS.background}>
      <View x={LAYOUT.safeX} y={160} width={panelW} height={460} color={COLORS.surface}
        borderRadius={LAYOUT.radius * 2} forwardFocus={0}>
        {isHome
          ? (
            <Row x={48} y={300} width={rowW} height={BUTTON_H} gap={LAYOUT.gap} scroll="none" autofocus>
              <For each={HOME_LINKS}>{(t) => <LinkButton target={t} />}</For>
            </Row>
          )
          : <View x={48} y={300} width={2} height={2} autofocus />}
        <Text x={48} y={48} fontSize={TYPE.display} color={COLORS.text}>{TITLES[screen]}</Text>
        <Text x={48} y={124} fontSize={TYPE.body} color={COLORS.muted}>
          {`This is the ${TITLES[screen]} screen (placeholder).`}
        </Text>
        <Text x={48} y={172} fontSize={TYPE.meta} color={COLORS.muted}>
          {`${params ? `Params: ${params}. ` : ''}${isHome ? 'Ok opens a screen. ' : ''}${isRoot ? 'Back asks to exit.' : 'Back returns.'}`}
        </Text>
      </View>
    </View>
  );
}
