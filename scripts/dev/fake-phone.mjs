#!/usr/bin/env node
// Dev tool: a fake phone companion for checking the TV pairing screen without the companion web app.
// It pairs with a TV session through the dev relay, says hello, asks for the state once, then stays connected,
// pinging every 25 s like the real companion (the TV shows the phone as gone after 75 s of silence).
//
// Usage (with `pnpm relay:dev` and the TV dev server running, the TV on Settings → Manage on phone or computer):
//   pnpm fake-phone '<QR URL or #s=…&k=… fragment>'   [--label "Fake phone"] [--seconds 60] [--no-bye]
//   pnpm fake-phone ABCD-EFGH-JKMN                       (code mode; the code shown on the TV)
// In the TV dev build, read what the pairing screen shows from the DevTools console: `__iptv.pairing()` gives
// `{ mode, qrUrl | code, expiresAt }` (DEV only; the app never logs it).
//
// --seconds N   disconnect after N seconds (default: stay until Ctrl+C)
// --no-bye      leave without saying bye (simulates a phone that dropped off)
// RELAY_URL     defaults to ws://127.0.0.1:8787. The Origin header is the dev companion origin, as the relay
//               only accepts a phone socket from an allowed origin.
//
// Dev only. It prints message types and counts, never the pairing secrets or any state contents.

import WebSocket from 'ws';
import {
  PING_INTERVAL_MS, PROTOCOL_VERSION, SecureChannel, WebSocketRelayTransport, isTvToPhone, normalizeCode, secretsFromCode,
  secretsFromQrFragment,
} from '../../packages/companion-protocol/src/index.ts';

const RELAY = (process.env.RELAY_URL ?? 'ws://127.0.0.1:8787').replace(/\/+$/, '');
const ORIGIN = process.env.COMPANION_ORIGIN ?? 'http://localhost:5174';

function parseArgs(argv) {
  const out = { pairing: undefined, label: 'Fake phone', seconds: undefined, bye: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') out.label = argv[++i] ?? out.label;
    else if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--no-bye') out.bye = false;
    else if (!out.pairing) out.pairing = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.pairing) {
  console.error('Usage: pnpm fake-phone <QR URL | #s=…&k=… | XXXX-XXXX-XXXX> [--label L] [--seconds N] [--no-bye]');
  process.exit(2);
}

let secrets;
const hash = args.pairing.indexOf('#');
if (hash >= 0 || args.pairing.startsWith('s=')) {
  secrets = await secretsFromQrFragment(hash >= 0 ? args.pairing.slice(hash) : args.pairing);
} else {
  const code = normalizeCode(args.pairing);
  if (!code) {
    console.error('Not a valid pairing code.');
    process.exit(2);
  }
  console.log('Deriving the key from the code (PBKDF2)…');
  secrets = await secretsFromCode(code);
}

/** `ws` with the companion Origin header (the browser sets it on its own). */
class OriginWebSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: ORIGIN });
  }
}

const transport = new WebSocketRelayTransport({
  url: `${RELAY}/v1/session/${secrets.sessionIdB64}/ws?role=phone`,
  WebSocket: OriginWebSocket,
  deadline: Date.now() + 60 * 60_000,
});
const channel = new SecureChannel({ secrets, role: 'phone', transport, validate: isTvToPhone });

/** The `state.version` last received, so a re-request after a reconnect can get `stateUnchanged`. */
let haveVersion;
let linkUp = true;
const getState = () => channel.send(haveVersion === undefined ? { t: 'getState' } : { t: 'getState', haveVersion }).catch(() => {});

transport.onDisconnected?.(() => {
  linkUp = false;
  console.log('[relay] disconnected, reconnecting…');
});
transport.onReconnected?.(() => {
  linkUp = true;
  console.log('[relay] reconnected');
  void getState();
});
// Presence: the TV counts the phone as gone after 75 s without a message.
const pinger = setInterval(() => {
  if (linkUp) channel.send({ t: 'ping' }).catch(() => {});
}, PING_INTERVAL_MS);

channel.onMessage((msg) => {
  switch (msg.t) {
    case 'welcome': console.log(`[tv] welcome (app ${msg.tv.appVersion}, protocol ${msg.tv.protocol})`); break;
    case 'state':
      haveVersion = msg.state.version;
      console.log(`[tv] state: ${msg.state.channels.length} channels, ${msg.state.sources.length} sources`);
      break;
    case 'stateUnchanged': console.log(`[tv] state unchanged (version ${msg.version})`); break;
    case 'result':
      if (!msg.ok) console.log(`[tv] result: ${msg.error?.name ?? 'error'}`);
      break;
    case 'bye': console.log('[tv] bye'); finish(0, false); break;
    default: console.log(`[tv] ${msg.t}`);
  }
});
channel.onClose((reason) => {
  console.log(`[channel] closed (${reason})`);
  process.exit(0);
});

let finished = false;
function finish(code, sayBye) {
  if (finished) return;
  finished = true;
  const done = () => {
    clearInterval(pinger);
    channel.close();
    process.exit(code);
  };
  if (!sayBye) return done();
  const t = setTimeout(done, 1000);
  channel.send({ t: 'bye' }).then(() => setTimeout(() => { clearTimeout(t); done(); }, 200), done);
}

process.on('SIGINT', () => finish(0, args.bye));
if (Number.isFinite(args.seconds)) setTimeout(() => finish(0, args.bye), args.seconds * 1000);

await channel.send({ t: 'hello', client: { kind: 'phone', label: args.label, protocol: PROTOCOL_VERSION } });
await getState();
console.log('[phone] hello + getState sent; Ctrl+C to leave');
