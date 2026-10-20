import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFakeXtream } from '../src/server.ts';

const NOW = Date.UTC(2026, 9, 13, 18, 10);
// Big enough that buffering the whole guide before the first byte (the old behaviour) takes well over the limit below.
const CHANNELS = 8000;
let server: Awaited<ReturnType<typeof startFakeXtream>>;
beforeAll(async () => { server = await startFakeXtream({ port: 0, channels: CHANNELS, catchup: true, now: () => NOW }); });
afterAll(async () => { await server.close(); });

const guideUrl = () => `${server.url}/xmltv.php?username=test&password=test`;
const api = () => fetch(`${server.url}/player_api.php?username=test&password=test`).then((r) => r.json());

describe('large XMLTV guide streams', () => {
  test('first bytes arrive quickly, other requests are served meanwhile, and the whole guide still arrives', async () => {
    const started = performance.now();
    const res = await fetch(guideUrl());
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstByteMs = performance.now() - started;
    expect(first.done).toBe(false);
    expect(firstByteMs).toBeLessThan(200);

    // The guide is far from done (we stopped reading), yet the API still answers.
    const info = await api();
    expect(info.user_info.auth).toBe(1);

    const decoder = new TextDecoder();
    let tail = decoder.decode(first.value, { stream: true });
    let bytes = first.value!.byteLength;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-64);
    }
    expect(bytes).toBeGreaterThan(200_000_000);
    expect(tail.endsWith('</tv>\n')).toBe(true);
  }, 60_000);

  test('a client that aborts mid-guide does not break the server', async () => {
    const ctl = new AbortController();
    const res = await fetch(guideUrl(), { signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    await reader.read().catch(() => undefined);
    const info = await api();
    expect(info.user_info.auth).toBe(1);
  }, 30_000);
});
