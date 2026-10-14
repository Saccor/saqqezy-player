import { Config, createRenderer, registerDefaultShaders } from '@lightningtv/solid';
import type { RendererMain } from '@lightningjs/renderer';
import { WebGlRenderer } from '@lightningjs/renderer/webgl';
import { CanvasTextRenderer } from '@lightningjs/renderer/canvas';
import { App } from './App.tsx';
import { api } from './api.ts';
import { router } from './shell/router.ts';
import { showToast } from './shell/Toast.tsx';
import { installKeys } from './input/keys.ts';
import { playback, player, videoLayer as layer } from './playback/playback.ts';
import { DESIGN_HEIGHT, DESIGN_WIDTH, designScale } from './video/videoLayer.ts';

// Canvas text with the platform's default sans-serif face: no font files are bundled.
Config.fontSettings = { fontFamily: 'sans-serif', fontSize: 32, color: 0xe8eaf0ff };
Config.animationsEnabled = true;

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('index.html is missing #app');

const { render, renderer } = createRenderer(
  {
    appWidth: DESIGN_WIDTH,
    appHeight: DESIGN_HEIGHT,
    deviceLogicalPixelRatio: designScale(),
    // Fully transparent: the <video> beneath shows wherever nothing is drawn.
    clearColor: 0x00000000,
    renderEngine: WebGlRenderer,
    fontEngines: [CanvasTextRenderer],
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
if (import.meta.env.DEV) (window as unknown as { __iptv: unknown }).__iptv = { player, layer, playback, api, router, showToast };

installKeys();
render(() => <App />);
