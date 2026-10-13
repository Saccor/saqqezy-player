import { Config, createRenderer, registerDefaultShaders } from '@lightningtv/solid';
import type { RendererMain } from '@lightningjs/renderer';
import { WebGlRenderer } from '@lightningjs/renderer/webgl';
import { CanvasTextRenderer } from '@lightningjs/renderer/canvas';
import { App } from './App.tsx';
import { installKeys } from './input/keys.ts';
import { Html5Player } from './video/Html5Player.ts';
import { DESIGN_HEIGHT, DESIGN_WIDTH, createVideoLayer, designScale } from './video/videoLayer.ts';

// Canvas text with the platform's default sans-serif face: no font files are bundled.
Config.fontSettings = { fontFamily: 'sans-serif', fontSize: 32, color: 0xe8eaf0ff };
Config.animationsEnabled = true;

const videoRoot = document.getElementById('video-layer');
const appRoot = document.getElementById('app');
if (!videoRoot || !appRoot) throw new Error('index.html is missing #video-layer or #app');

const layer = createVideoLayer(videoRoot);
// Dev-only switch to exercise the hls.js path on browsers that also have native HLS: `?hlsjs`.
const forceHlsJs = import.meta.env.DEV && new URLSearchParams(location.search).has('hlsjs');
const player = new Html5Player(layer, { preferNativeHls: !forceHlsJs });

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
if (import.meta.env.DEV) (window as unknown as { __iptv: unknown }).__iptv = { player, layer };

installKeys();
render(() => <App player={player} />);
