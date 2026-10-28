import { For, Text, View } from '@lightningtv/solid';
import { Row } from '@lightningtv/solid/primitives';
import { SETTINGS_COPY } from '../copy.ts';
import { Button, BUTTON_H } from '../components/Button.tsx';
import { router, type ScreenEntry, type ScreenId } from '../shell/router.ts';
import { COLORS, LAYOUT, LINE, RADIUS, SPACE, TYPE } from '../shell/theme.ts';

const TITLES: Record<ScreenId, string> = SETTINGS_COPY.placeholder.titles;

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
  const params = Object.entries(props.entry.params).map(([k, v]) => `${k}=${String(v)}`).join(', ');
  const panelW = LAYOUT.width - LAYOUT.safeX * 2;
  const rowW = HOME_LINKS.length * (BTN_W + LAYOUT.gap) - LAYOUT.gap;

  return (
    <View width={LAYOUT.width} height={LAYOUT.height} color={screen === 'player' ? COLORS.transparent : COLORS.background}>
      <View x={LAYOUT.safeX} y={SPACE.xl * 3} width={panelW} height={460} color={COLORS.surface}
        borderRadius={RADIUS.card} forwardFocus={0}>
        {isHome
          ? (
            <Row x={48} y={SPACE.xl * 6} width={rowW} height={BUTTON_H} gap={LAYOUT.gap} scroll="none" autofocus>
              <For each={HOME_LINKS}>{(t) => <LinkButton target={t} />}</For>
            </Row>
          )
          : <View x={48} y={SPACE.xl * 6} width={2} height={2} autofocus />}
        <Text x={48} y={48} fontSize={TYPE.title} color={COLORS.text}>{TITLES[screen]}</Text>
        <Text x={48} y={SPACE.xl + LINE.title + SPACE.m} fontSize={TYPE.body} color={COLORS.muted}>
          {SETTINGS_COPY.placeholder.screen(TITLES[screen])}
        </Text>
        <Text x={48} y={SPACE.xl + LINE.title + SPACE.m + LINE.body + SPACE.s} fontSize={TYPE.meta} color={COLORS.muted}>
          {params ? SETTINGS_COPY.placeholder.params(params) : ''}
        </Text>
      </View>
    </View>
  );
}
