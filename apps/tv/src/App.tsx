import { For, Text, View } from '@lightningtv/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { Column, Row, useFocusManager } from '@lightningtv/solid/primitives';
import type { Player, Rect } from '@iptv/player';
import { api } from './api.ts';
import { LIGHTNING_KEY_MAP, LONG_PRESS_MS, onLogicalKey } from './input/keys.ts';

const THEME = {
  background: 0x0b0d12ff,
  panel: 0x0b0d12e6, // semi-transparent
  surface: 0x151a24ff,
  focus: 0x4f8cffff,
  text: 0xe8eaf0ff,
  muted: 0x7d8496ff,
  scrim: 0x0b0d12a0,
};

/** Test stream for the spike (public HLS test vector). */
const TEST_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

/** The transparent hole, in 1920x1080 design space. */
export const HOLE: Rect = { x: 1184, y: 200, w: 640, h: 360 };
const SAFE_X = 96;
const SAFE_Y = 54;

/** Small runtime-generated image, to prove image loading without bundling assets. */
function badgeDataUrl(): string {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#4f8cff';
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b0d12';
    g.beginPath();
    g.moveTo(24, 18);
    g.lineTo(48, 32);
    g.lineTo(24, 46);
    g.fill();
  }
  return c.toDataURL('image/png');
}

function Tile(props: { label: string; onAction: (text: string) => void }) {
  const [focused, setFocused] = createSignal(false);
  return (
    <View
      width={240}
      height={135}
      borderRadius={12}
      color={focused() ? THEME.focus : THEME.surface}
      scale={focused() ? 1.06 : 1}
      onFocusChanged={setFocused}
      onEnter={() => { props.onAction(`Ok on ${props.label}`); return true; }}
      onLongOk={() => { props.onAction(`LongOk on ${props.label}`); return true; }}
    >
      <Text x={20} y={48} fontSize={30} color={focused() ? 0xffffffff : THEME.text}>{props.label}</Text>
    </View>
  );
}

export function App(props: { player: Player }) {
  useFocusManager(LIGHTNING_KEY_MAP);

  const [lastKey, setLastKey] = createSignal('none yet');
  const [lastAction, setLastAction] = createSignal('');
  const [sources, setSources] = createSignal('Connecting to worker...');
  const [playState, setPlayState] = createSignal('idle');

  onCleanup(onLogicalKey((k) => {
    setLastKey(k);
    console.log(`[keys] ${k}`);
  }));

  onMount(() => {
    api.init()
      .then((s) => setSources(`${s.sources.length} sources`))
      .catch((e: unknown) => setSources(`Worker error: ${e instanceof Error ? e.message : String(e)}`));

    const off = props.player.onState((s, d) => setPlayState(d?.code ? `${s} (${d.code})` : s));
    props.player.setRect(HOLE);
    void props.player.open(TEST_STREAM, 1);
    onCleanup(() => { off(); props.player.stop(); });
  });

  // Rows share one column index, so Up/Down keep the column like a grid.
  const [column, setColumn] = createSignal(0);
  const rows = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => `Tile ${r * 4 + c + 1}`));

  return (
    <View width={1920} height={1080}>
      {/* Semi-transparent panels framing the hole; nothing is drawn inside the hole. */}
      <View x={0} y={0} width={HOLE.x} height={1080} color={THEME.panel} />
      <View x={HOLE.x + HOLE.w} y={0} width={1920 - HOLE.x - HOLE.w} height={1080} color={THEME.panel} />
      <View x={HOLE.x} y={0} width={HOLE.w} height={HOLE.y} color={THEME.panel} />
      <View x={HOLE.x} y={HOLE.y + HOLE.h} width={HOLE.w} height={1080 - HOLE.y - HOLE.h} color={THEME.panel} />
      <View x={HOLE.x - 4} y={HOLE.y - 4} width={HOLE.w + 8} height={HOLE.h + 8} color={0x00000000}
        border={{ width: 4, color: THEME.focus }} />
      {/* UI drawn on top of the video, inside the hole. */}
      <View x={HOLE.x} y={HOLE.y + HOLE.h - 56} width={HOLE.w} height={56} color={THEME.scrim}>
        <Text x={20} y={12} fontSize={26} color={THEME.text}>{`Preview: ${playState()}`}</Text>
      </View>

      <View x={SAFE_X} y={SAFE_Y} width={64} height={64} src={badgeDataUrl()} />
      <Text x={SAFE_X + 84} y={SAFE_Y + 10} fontSize={40} color={THEME.text}>IPTV Player: UI stack spike</Text>

      <Column x={SAFE_X} y={180} width={1032} height={460} gap={24} scroll="none" autofocus>
        <For each={rows}>
          {(row) => (
            <Row width={1032} height={135} gap={24} scroll="none" selected={column()}
              onSelectedChanged={(i) => setColumn(i)}>
              <For each={row}>{(label) => <Tile label={label} onAction={setLastAction} />}</For>
            </Row>
          )}
        </For>
      </Column>

      <Text x={SAFE_X} y={700} fontSize={32} color={THEME.text}>{`Last key: ${lastKey()}`}</Text>
      <Text x={SAFE_X} y={750} fontSize={28} color={THEME.muted}>{lastAction() || `Hold Ok ${LONG_PRESS_MS} ms for LongOk`}</Text>
      <Text x={SAFE_X} y={800} fontSize={32} color={THEME.text}>{`Sources: ${sources()}`}</Text>
    </View>
  );
}
