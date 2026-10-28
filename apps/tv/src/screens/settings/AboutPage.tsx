import { Text, View } from '@lightningtv/solid';
import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { SETTINGS_COPY } from '../../copy.ts';
import { aboutAttribution } from '../../net/trendingConfig.ts';
import { COLORS, LINE, SPACE, TYPE } from '../../shell/theme.ts';
import type { PageProps } from './shared.ts';

const A = SETTINGS_COPY.about;
export const APP_NAME = A.app;
export const LEGAL_TEXT = `${A.legal} ${A.responsibility}`;
export const CONTACT_TEXT = A.contact;
/** Data-source credits for Start's trending rows (Wikimedia and Wikidata; TMDB only in builds that use its key). */
const ATTRIBUTION = aboutAttribution({
  VITE_TRENDING_URL: import.meta.env.VITE_TRENDING_URL as string | undefined,
  VITE_TMDB_ATTRIBUTION: import.meta.env.VITE_TMDB_ATTRIBUTION as string | undefined,
  DEV: import.meta.env.DEV,
});

/** About: name, version, the legal notice, the copyright contact line and data-source credits. Nothing to focus. */
export function AboutPage(props: PageProps) {
  const [version, setVersion] = createSignal('');
  let alive = true;
  onMount(() => {
    props.register(undefined);
    api.diagnostics().then((d) => { if (alive) setVersion(d.appVersion); }, () => undefined);
  });
  onCleanup(() => { alive = false; });
  const w = props.width - SPACE.l * 2;
  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <Text x={SPACE.l} y={8} fontSize={TYPE.title} color={COLORS.text}>{APP_NAME}</Text>
      <Text x={SPACE.l} y={SPACE.xl + SPACE.l} fontSize={TYPE.body} color={COLORS.muted}>{version() ? A.version(version()) : ''}</Text>
      <Text x={SPACE.l} y={SPACE.xl * 3} width={w} maxWidth={w} contain="width" lineHeight={LINE.body} fontSize={TYPE.body}
        color={COLORS.text}>{LEGAL_TEXT}</Text>
      <Text x={SPACE.l} y={SPACE.xl * 5 + SPACE.l} width={w} maxWidth={w} contain="width" fontSize={TYPE.body}
        color={COLORS.muted}>{CONTACT_TEXT}</Text>
      <For each={ATTRIBUTION}>{(line, i) => (
        <Text x={SPACE.l} y={SPACE.xl * 7 + i() * (SPACE.xl + SPACE.l)} width={w} maxWidth={w} contain="width" lineHeight={LINE.meta} fontSize={TYPE.meta}
          color={COLORS.muted}>{line}</Text>
      )}</For>
    </View>
  );
}
