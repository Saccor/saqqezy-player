import { Text, View } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { api } from '../../api.ts';
import { COLORS, FONT } from '../../shell/theme.ts';
import type { PageProps } from './shared.ts';

export const APP_NAME = 'IPTV Player';
export const LEGAL_TEXT = 'This app is a media player. It does not provide any channels, streams or content. '
  + 'You are responsible for making sure you have the right to use the sources you add.';
export const CONTACT_TEXT = 'Copyright contact: see the website listed in the store.';

/** About: name, version, the legal notice and the copyright contact line. Nothing to focus. */
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
      <Text x={28} y={8} fontSize={FONT.title} color={COLORS.text}>{APP_NAME}</Text>
      <Text x={28} y={80} fontSize={FONT.body} color={COLORS.muted}>{version() ? `Version ${version()}` : ''}</Text>
      <Text x={28} y={150} width={w} maxWidth={w} contain="width" lineHeight={40} fontSize={FONT.body}
        color={COLORS.text}>{LEGAL_TEXT}</Text>
      <Text x={28} y={270} width={w} maxWidth={w} contain="width" fontSize={FONT.body}
        color={COLORS.muted}>{CONTACT_TEXT}</Text>
    </View>
  );
}
