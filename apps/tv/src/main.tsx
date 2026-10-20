import { Config, createRenderer, registerDefaultShaders } from '@lightningtv/solid';
import type { RendererMain } from '@lightningjs/renderer';
import { WebGlRenderer } from '@lightningjs/renderer/webgl';
import { CanvasTextRenderer } from '@lightningjs/renderer/canvas';
import { COLORS } from './shell/theme.ts';
import { CorsWebPlatform } from './shell/corsPlatform.ts';
import { App } from './App.tsx';
import { api } from './api.ts';
import { router } from './shell/router.ts';
import { showToast } from './shell/Toast.tsx';
import { installKeys, onUserGesture } from './input/keys.ts';
import { installPointer } from './input/pointer.ts';
import { installFormatReport } from './playback/formatReport.ts';
import { playback, player, supervisor, videoLayer as layer } from './playback/playback.ts';
import { DESIGN_HEIGHT, DESIGN_WIDTH, designScale } from './video/videoLayer.ts';
// Applies the saved volume to the player before anything plays (Home's preview too).
import './video/volume.ts';
import { platformId } from './state/appState.ts';
import { registerKeys } from './platform/tizen.ts';
import { devPairing } from './screens/settings/ManageOnPhonePage.tsx';

// Canvas text with the platform's default sans-serif face: no font files are bundled.
Config.fontSettings = { fontFamily: 'sans-serif', fontSize: 32, color: COLORS.text };
Config.animationsEnabled = true;

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('index.html is missing #app');

const { render, renderer } = createRenderer(
  {
    appWidth: DESIGN_WIDTH,
    appHeight: DESIGN_HEIGHT,
    deviceLogicalPixelRatio: designScale(),
    // Fully transparent: the <video> beneath shows wherever nothing is drawn.
    clearColor: COLORS.transparent,
    renderEngine: WebGlRenderer,
    fontEngines: [CanvasTextRenderer],
    // SVG posters and logos load with CORS, so a cross-origin SVG no longer taints the canvas (shell/svgLoad.ts).
    platform: CorsWebPlatform,
    // Poster and backdrop textures on a 1 GB TV. Images are decoded at their natural size: renderer 3.7 has no
    // decode-time resize (ImageTexture `sx/sy/sw/sh` only crop, and its image worker never passes `resizeWidth` /
    // `resizeHeight` to `createImageBitmap`), so a 600×900 poster shown at 188×282 still costs ~2 MB of GPU memory.
    // Until a resize step exists (Plan 4/5), the budget bounds it: past 100 MB (the 25 MB WebGL baseline included) the
    // renderer frees textures that are off screen down to half of that, and an idle scene is tidied every 5 s.
    textureMemory: {
      criticalThreshold: 100e6,
      targetThresholdLevel: 0.5,
      cleanupInterval: 5_000,
    },
  },
  appRoot,
);
// borderRadius / border / shadow / gradients resolve to these shader types.
registerDefaultShaders((renderer as RendererMain).stage.shManager);

window.addEventListener('resize', () => {
  (renderer as RendererMain).setOptions({ deviceLogicalPixelRatio: designScale() });
  layer.relayout();
});

// Dev-only debug handle for the browser console; stripped from production builds.
if (import.meta.env.DEV) (window as unknown as { __iptv: unknown }).__iptv = {
  player, layer, playback, api, router, showToast, renderer, pairing: devPairing,
};

// Tizen only delivers colour, digit, channel, play/pause and info keys that the app registers.
if (platformId === 'tizen') registerKeys();
// Desktop autoplay may have started the stream muted: the first key press or mouse click gives the sound back.
onUserGesture(() => player.unmuteIfAutoMuted?.());
// The worker remembers per source which stream format played last and tries it first next time (no URL is sent).
installFormatReport({
  onStatus: (fn) => supervisor.onStatus(fn),
  current: () => playback.current(),
  inFlight: () => player.currentUrl(),
  report: (id, format) => { void api.notePlayed(id, format).catch(() => undefined); },
});
installKeys();
// Mouse and pointer remotes (desktop, the LG Magic Remote); a no-op on Tizen.
installPointer({ canvas: (renderer as RendererMain).canvas, platform: platformId });
render(() => <App />);
