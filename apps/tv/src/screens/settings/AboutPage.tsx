import { Text, View } from '@lightningtv/solid';
import { createSignal, For, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { aboutAttribution } from '../../net/trendingConfig.ts';
import { COLORS, TYPE } from '../../shell/theme.ts';
import type { PageProps } from './shared.ts';

export const APP_NAME = 'IPTV Player';
export const LEGAL_TEXT = 'This app is a media player. It does not provide any channels, streams or content. '
  + 'You are responsible for making sure you have the right to use the sources you add.';
export const CONTACT_TEXT = 'Copyright contact: see the website listed in the store.';
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
  const w = props.width - 56;
  return (
    <View x={props.x} y={props.y} width={props.width} height={props.height}>
      <Text x={28} y={8} fontSize={TYPE.display} color={COLORS.text}>{APP_NAME}</Text>
      <Text x={28} y={80} fontSize={TYPE.body} color={COLORS.muted}>{version() ? `Version ${version()}` : ''}</Text>
      <Text x={28} y={150} width={w} maxWidth={w} contain="width" lineHeight={40} fontSize={TYPE.body}
        color={COLORS.text}>{LEGAL_TEXT}</Text>
      <Text x={28} y={270} width={w} maxWidth={w} contain="width" fontSize={TYPE.body}
        color={COLORS.muted}>{CONTACT_TEXT}</Text>
      <For each={ATTRIBUTION}>{(line, i) => (
        <Text x={28} y={350 + i() * 80} width={w} maxWidth={w} contain="width" lineHeight={36} fontSize={TYPE.meta}
          color={COLORS.muted}>{line}</Text>
      )}</For>
    </View>
  );
}
