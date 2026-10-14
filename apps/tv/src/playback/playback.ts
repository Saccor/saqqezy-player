import { PlaybackSupervisor } from '@iptv/player';
import { setSupervisorStatus } from '../state/appState.ts';
import { Html5Player } from '../video/Html5Player.ts';
import { createVideoLayer } from '../video/videoLayer.ts';
import { createPlaybackController } from './controller.ts';

/**
 * The app's single playback stack: one `<video>` layer, one player, one `PlaybackSupervisor`. The Home
 * preview and the fullscreen Player share it, so only one stream is ever open and going fullscreen is just a
 * rect change. (Tizen's `AvplayPlayer` is selected here once it exists; until then every platform uses
 * `Html5Player`.)
 */
const videoRoot = document.getElementById('video-layer');
if (!videoRoot) throw new Error('index.html is missing #video-layer');

export const videoLayer = createVideoLayer(videoRoot);

// Dev-only switch to exercise the hls.js path on browsers that also have native HLS: `?hlsjs`.
const forceHlsJs = import.meta.env.DEV && new URLSearchParams(location.search).has('hlsjs');
export const player = new Html5Player(videoLayer, { preferNativeHls: !forceHlsJs });

export const supervisor = new PlaybackSupervisor(player);

/** `playChannel`, `stop`, `setRect`, `status` and `current`; status changes also feed the debug overlay. */
export const playback = createPlaybackController(player, supervisor, setSupervisorStatus);
