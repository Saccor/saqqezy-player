#!/usr/bin/env node
// Integration check against a running relay (`pnpm relay:dev`). Not part of `pnpm test`.
// Usage: pnpm relay:test:int   (RELAY_URL defaults to ws://127.0.0.1:8787)
// Exits non-zero on the first failure. Uses random, synthetic session ids and frames.

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const RELAY = (process.env.RELAY_URL ?? 'ws://127.0.0.1:8787').replace(/\/$/, '');
const HTTP = RELAY.replace(/^ws/, 'http');
const COMPANION_ORIGIN = 'http://localhost:5174';
const TIMEOUT_MS = 5000;
// Must match the relay's never-paired TTL. `pnpm relay:dev` sets it to 60 s; production is 15 min.
const TTL_UNPAIRED_MS = Number(process.env.RELAY_TTL_UNPAIRED_MS ?? 60_000);

const sid = () => randomBytes(16).toString('base64url');
const url = (id, role) => `${RELAY}/v1/session/${id}/ws?role=${role}`;

function open(id, role, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(id, role), origin ? { origin } : {});
    ws.binaryType = 'nodebuffer';
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (data, isBinary) => {
      const msg = { data: Buffer.from(data), isBinary };
      const w = ws.waiters.shift();
      if (w) w(msg); else ws.inbox.push(msg);
    });
    ws.closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function next(ws) {
  const queued = ws.inbox.shift();
  if (queued) return Promise.resolve(queued);
  return withTimeout(new Promise((res) => ws.waiters.push(res)), 'message');
}

function withTimeout(p, what, ms = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${HTTP}/healthz`);
      if (r.status === 200 && (await r.text()) === 'ok') return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`relay not reachable at ${HTTP}/healthz (run pnpm relay:dev)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const checks = [];
const check = (name, fn, timeoutMs = TIMEOUT_MS) => checks.push({ name, fn, timeoutMs });

check('healthz', async () => {
  const r = await fetch(`${HTTP}/healthz`);
  assert(r.status === 200, `status ${r.status}`);
});

check('forwards binary frames unchanged in both directions', async () => {
  const id = sid();
  const tv = await open(id, 'tv'); // a packaged TV app may send no Origin
  const phone = await open(id, 'phone', COMPANION_ORIGIN);
  const a = randomBytes(1024);
  tv.send(a);
  const got = await next(phone);
  assert(got.isBinary && got.data.equals(a), 'tv -> phone payload');
  const b = randomBytes(262_166); // largest wire frame from companion-protocol
  phone.send(b);
  const got2 = await next(tv);
  assert(got2.isBinary && got2.data.equals(b), 'phone -> tv payload');
  tv.close(); phone.close();
});

check('queues while the peer reconnects', async () => {
  const id = sid();
  const tv = await open(id, 'tv');
  const phone = await open(id, 'phone', COMPANION_ORIGIN);
  phone.close();
  await withTimeout(phone.closed, 'phone close');
  await new Promise((r) => setTimeout(r, 100));
  const a = randomBytes(64);
  tv.send(a);
  await new Promise((r) => setTimeout(r, 100));
  const phone2 = await open(id, 'phone', COMPANION_ORIGIN);
  const got = await next(phone2);
  assert(got.data.equals(a), 'queued frame delivered on reconnect');
  tv.close(); phone2.close();
});

check('a second socket of the same role replaces the first with 4001', async () => {
  const id = sid();
  const tv1 = await open(id, 'tv');
  const tv2 = await open(id, 'tv');
  const c = await withTimeout(tv1.closed, 'replaced close');
  assert(c.code === 4001, `close code ${c.code}`);
  tv2.close();
});

check('an oversized frame closes the sender with 4002', async () => {
  const id = sid();
  const tv = await open(id, 'tv');
  tv.send(randomBytes(300 * 1024 + 1));
  const c = await withTimeout(tv.closed, 'too-large close');
  assert(c.code === 4002, `close code ${c.code}`);
});

check('an unknown role is closed with 4004', async () => {
  const ws = await open(sid(), 'admin', COMPANION_ORIGIN);
  const c = await withTimeout(ws.closed, 'bad-role close');
  assert(c.code === 4004, `close code ${c.code}`);
});

check('an unknown role with no Origin is 403', async () => {
  let refused = false;
  try { (await open(sid(), 'admin')).close(); } catch (e) { refused = /HTTP 403/.test(String(e)); }
  assert(refused, 'bad role without origin refused with 403');
});

check('a phone from an unlisted or null origin is refused', async () => {
  for (const origin of ['http://other.example.test', 'null']) {
    let refused = false;
    try { (await open(sid(), 'phone', origin)).close(); } catch (e) { refused = /HTTP 403/.test(String(e)); }
    assert(refused, `origin ${origin} refused with 403`);
  }
});

check('a phone with no Origin is refused', async () => {
  let refused = false;
  try { (await open(sid(), 'phone')).close(); } catch (e) { refused = /HTTP 403/.test(String(e)); }
  assert(refused, 'missing origin refused with 403');
});

check('a 0-byte ping is not forwarded', async () => {
  const id = sid();
  const tv = await open(id, 'tv');
  const phone = await open(id, 'phone', COMPANION_ORIGIN);
  tv.send(Buffer.alloc(0));
  const a = randomBytes(16);
  tv.send(a);
  const got = await next(phone);
  assert(got.data.equals(a), `the first frame the phone sees is the real one (got ${got.data.length} bytes)`);
  phone.send(Buffer.alloc(0));
  await new Promise((r) => setTimeout(r, 200));
  assert(tv.inbox.length === 0, 'tv received nothing for the phone ping');
  tv.close(); phone.close();
});

check('a malformed session id is 404', async () => {
  const r = await fetch(`${HTTP}/v1/session/not-a-session/ws?role=tv`);
  assert(r.status === 404, `status ${r.status}`);
});

// Slow: waits for the never-paired TTL. Keep it last.
check(`a never-paired session is closed with 4000 after ${TTL_UNPAIRED_MS / 1000} s`, async () => {
  const started = Date.now();
  const tv = await open(sid(), 'tv');
  const c = await tv.closed;
  const elapsed = Date.now() - started;
  assert(c.code === 4000 && c.reason === 'expired', `close ${c.code} ${c.reason}`);
  assert(elapsed >= TTL_UNPAIRED_MS - 1000, `closed too early (${elapsed} ms)`);
}, TTL_UNPAIRED_MS + 15_000);

await waitForHealth();
let failed = 0;
for (const { name, fn, timeoutMs } of checks) {
  try {
    await withTimeout(fn(), name, timeoutMs);
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(failed === 0 ? `\nall ${checks.length} checks passed` : `\n${failed} of ${checks.length} checks failed`);
process.exit(failed === 0 ? 0 : 1);
