// Captures the app screenshots from the TV app's dev server: the website's (apps/site/public/screens/*.webp) or, with
// `readme`, the README's (docs/images/*.webp).
//
// Needs, already running: the TV dev server on :5173 (`pnpm dev`) and a showcase provider on :8900
// (`PORT=8900 SHOWCASE=1 SPORTS=0 pnpm fake-xtream`). Needs Chrome and ffmpeg. Run from the repository root:
//   node apps/site/scripts/screens.mjs [readme]
// Every name and poster on screen comes from the showcase provider (made up); the video is the licensed test stream.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:5173/';
const PROVIDER = 'http://127.0.0.1:8900';
const README = process.argv[2] === 'readme';
const OUT = README ? join('docs', 'images') : join('apps', 'site', 'public', 'screens');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'site-screens-'));
// --disable-web-security: the provider on :8900 is not behind the dev proxy, which only knows :8899.
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1936,1231',
  '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-web-security', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  await sleep(3000);
  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const d = JSON.parse(m);
    pending.get(d.id)?.(d.result);
    pending.delete(d.id);
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const CODES = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 };
  const key = async (k, times = 1) => {
    for (let n = 0; n < times; n++) {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: CODES[k] });
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const png = join(profile, `${name}.png`);
    writeFileSync(png, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, '-vf', 'scale=1600:-1', '-c:v', 'libwebp', '-quality', '82', join(OUT, `${name}.webp`)]);
    console.log('saved', name);
  };
  const go = async (expr, ms = 6000) => { await evaluate(`window.__iptv.router.reset(${expr})`); await sleep(ms); };

  await send('Page.navigate', { url: APP });
  await sleep(5000);
  await evaluate(`window.__iptv.api.addSource({ kind: 'xtream', name: 'Home server', server: '${PROVIDER}', username: 'test', password: 'test' })`);
  await evaluate('location.reload()');
  await sleep(10000);

  // OK on a guide row opens its options: Watch first, Preview second.
  const preview = async () => { await key('Enter'); await key('ArrowDown'); await key('Enter'); };
  const watch = async () => { await key('Enter'); await key('Enter'); };
  // In multiview, OK on a window opens its menu, where "Add channel" is third; the picker then lists every channel.
  const addWindow = async (row) => {
    await key('Enter');
    await key('ArrowDown', 2);
    await key('Enter');
    await sleep(1000);
    await key('ArrowDown', row);
    await key('Enter');
    await sleep(4000);
  };

  if (README) await readmeShots(); else await siteShots();

  async function siteShots() {
    // Guide with a live preview of channel 3, then that channel full screen with its banner.
    await key('ArrowDown', 2);
    await preview();
    await sleep(10000);
    await shot('guide');
    await watch();
    await sleep(1500);
    await shot('player');

    await go(`'vod', { kind: 'movie' }`);
    await key('ArrowRight', 2);
    await sleep(2500);
    await shot('movies');
    await key('Enter');
    await sleep(4000);
    await shot('detail');

    await go(`'vod', { kind: 'series' }`);
    await key('ArrowRight');
    await sleep(2500);
    await shot('series');
  }

  async function readmeShots() {
    await key('ArrowDown', 2);
    await preview();
    await sleep(10000);
    await shot('guide');
    await watch();
    await sleep(1500);
    await shot('player');

    // Four windows: channel 3 from the player, then three picked from the list.
    await evaluate(`window.__iptv.router.push('multiview', {})`);
    await sleep(3000);
    await key('ArrowDown', 4);
    await key('Enter');
    await sleep(4000);
    await addWindow(6);
    await addWindow(7);
    await sleep(6000);
    await shot('multiview');

    await go(`'vod', { kind: 'movie' }`);
    await key('ArrowRight', 2);
    await key('Enter');
    await sleep(4000);
    await shot('detail');

    await go(`'start'`, 8000);
    await shot('start');
  }
} finally {
  ws?.close();
  chrome.kill();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true });
}
