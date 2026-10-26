import { Index, Show, Text, View } from '@lightningtv/solid';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { SupervisorStatus } from '@iptv/player';
import { onLogicalKey, onUnmappedKey } from '../input/keys.ts';
import { platformId, startupMs, supervisorStatus } from '../state/appState.ts';
import { createTapSequence, slowestFrameMs } from './logic.ts';
import { COLORS, LAYOUT, RADIUS, TYPE } from './theme.ts';

const WIDTH = 460;
const LINE = 34;
const SAMPLE_MS = 500;
const HEIGHT = LINE * 7 + 16;

function describeStatus(s: SupervisorStatus | undefined): string {
  if (!s) return 'idle';
  if (s.kind === 'reconnecting') return `reconnecting (${s.attempt})`;
  if (s.kind === 'failed') return `failed (${s.reason})`;
  return s.kind;
}

/** The renderer canvas's drawing buffer (TVs cap it at 1920x1080, see `renderScale.ts`). */
function renderSize(): string {
  const c = document.querySelector<HTMLCanvasElement>('#app canvas');
  return c ? `${c.width}×${c.height}` : 'n/a';
}

function heapText(): string {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!mem) return 'n/a';
  return `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`;
}

/** Visibility of the HUD; also toggled from Settings > Diagnostics ("Show debug overlay"). */
const [visible, setVisible] = createSignal(false);
export { visible as debugOverlayVisible, setVisible as setDebugOverlayVisible };

/**
 * Developer HUD: startup time, FPS and the slowest frame of the last second, render buffer size, JS heap,
 * supervisor status, platform. Toggled by Info x3 within 2 s, or
 * F12 in the browser. It is a non-modal HUD (takes no focus and is not a Back layer).
 */
export function DebugOverlay() {
  const [fps, setFps] = createSignal(0);
  const [slowest, setSlowest] = createSignal(0);
  const [heap, setHeap] = createSignal('n/a');

  const infoTaps = createTapSequence(3, 2000);
  const offKey = onLogicalKey((k, e) => {
    // A held Info key auto-repeats; only real presses count as taps.
    if (e.repeat) return;
    if (k === 'Info' && infoTaps(performance.now())) setVisible((v) => !v);
  });
  const offRaw = onUnmappedKey((e) => {
    if (platformId === 'browser' && e.key === 'F12' && !e.repeat) setVisible((v) => !v);
  });

  // Rolling FPS: frames counted over the last second, sampled twice a second. Runs only while visible.
  let raf = 0;
  let frames: number[] = [];
  let lastSample = 0;
  const loop = (t: number) => {
    frames.push(t);
    while (frames.length > 0 && t - (frames[0] ?? t) > 1000) frames.shift();
    if (t - lastSample >= SAMPLE_MS) {
      lastSample = t;
      setFps(frames.length);
      setSlowest(Math.round(slowestFrameMs(frames)));
      setHeap(heapText());
    }
    raf = requestAnimationFrame(loop);
  };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; frames = []; };
  const toggleLoop = (on: boolean) => {
    if (on && raf === 0) { lastSample = 0; raf = requestAnimationFrame(loop); }
    if (!on) stop();
  };

  createEffect(() => toggleLoop(visible()));
  onCleanup(() => { offKey(); offRaw(); stop(); });

  const lines = () => {
    const s = startupMs();
    return [
      `Startup: ${s === undefined ? 'pending' : `${Math.round(s)} ms`}`,
      `FPS: ${fps()} · slowest frame ${slowest()} ms`,
      `Render: ${renderSize()}`,
      `JS heap: ${heap()}`,
      `Player: ${describeStatus(supervisorStatus())}`,
      `Platform: ${platformId}`,
    ];
  };

  return (
    <Show when={visible()}>
      <View x={LAYOUT.safeX} y={LAYOUT.height - LAYOUT.safeY - HEIGHT} width={WIDTH} height={HEIGHT} color={COLORS.panel}
        borderRadius={RADIUS.card} zIndex={100}>
        <Text x={16} y={12} fontSize={TYPE.meta} color={COLORS.accent}>Debug</Text>
        <Index each={lines()}>
          {(l, i) => <Text x={16} y={12 + LINE * (i + 1)} fontSize={TYPE.meta} color={COLORS.text}>{l()}</Text>}
        </Index>
      </View>
    </Show>
  );
}
