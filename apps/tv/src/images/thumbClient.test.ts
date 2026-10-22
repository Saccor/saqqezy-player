import { describe, expect, it } from 'vitest';
import { ThumbClient, thumbStatsLine, type PortLike } from './thumbClient.ts';
import type { ThumbReply, ThumbRequest } from './thumbService.ts';

function port() {
  const sent: ThumbRequest[] = [];
  const p: PortLike & { reply(r: ThumbReply): void; fail(): void; terminated: number } = {
    terminated: 0,
    terminate() { p.terminated += 1; },
    onmessage: null,
    onerror: null,
    postMessage: (m) => { sent.push(m); },
    reply(r) { p.onmessage?.({ data: r }); },
    fail() { p.onerror?.(new Error('boom')); },
  };
  return { p, sent };
}
const bm = { width: 2, height: 3 } as unknown as ImageBitmap;
const neverStock = () => Promise.reject(new Error('stock path not expected'));

describe('ThumbClient', () => {
  it('waits for the mode, sends the request and resolves with the transferred bitmap', async () => {
    const { p, sent } = port();
    const c = new ThumbClient(p);
    const loading = c.load('http://img.test/a.jpg', 188, 282, true, neverStock);
    p.reply({ t: 'mode', mode: 'full' });
    await Promise.resolve();
    expect(sent).toEqual([{ t: 'load', id: 1, url: 'http://img.test/a.jpg', w: 188, h: 282, alpha: true }]);
    p.reply({ t: 'ok', id: 1, bitmap: bm, premultiplyAlpha: true, from: 'fetched' });
    await expect(loading).resolves.toEqual({ data: bm, premultiplyAlpha: true, premultiplied: true });
    expect(c.stats()).toMatchObject({ fetched: 1, mode: 'full' });
  });

  it('rejects on err and counts the failure', async () => {
    const { p } = port();
    const c = new ThumbClient(p);
    p.reply({ t: 'mode', mode: 'shrink' });
    const loading = c.load('http://img.test/b.jpg', 10, 10, null, neverStock);
    await Promise.resolve();
    p.reply({ t: 'err', id: 1, message: 'HTTP 404' });
    await expect(loading).rejects.toThrow('HTTP 404');
    expect(c.stats().failed).toBe(1);
  });

  it('stock mode uses the renderer path and never posts', async () => {
    const { p, sent } = port();
    const c = new ThumbClient(p);
    p.reply({ t: 'mode', mode: 'stock' });
    const r = await c.load('http://img.test/c.jpg', 10, 10, true, async () => ({ data: bm, premultiplyAlpha: true }));
    expect(r.data).toBe(bm);
    expect(sent).toEqual([]);
  });

  it('counts kept and skipped copies', () => {
    const { p } = port();
    const c = new ThumbClient(p);
    p.reply({ t: 'copy', kept: true });
    p.reply({ t: 'copy', kept: false });
    p.reply({ t: 'copy', kept: true });
    expect(c.stats()).toMatchObject({ kept: 2, skipped: 1 });
  });
});

describe('ThumbClient worker failure', () => {
  const stockOk = () => Promise.resolve({ data: bm, premultiplyAlpha: true });

  it('an error before the mode rejects pending loads and sends later ones to the stock path', async () => {
    const { p, sent } = port();
    const c = new ThumbClient(p);
    const pending = c.load('http://img.test/a.jpg', 10, 10, true, stockOk);
    p.fail();
    // before the mode, nothing was posted, so the pending load takes the stock path
    await expect(pending).resolves.toEqual({ data: bm, premultiplyAlpha: true });
    expect(sent).toEqual([]);
  });

  it('an error rejects loads already sent and counts them; later loads are stock', async () => {
    const { p } = port();
    const c = new ThumbClient(p);
    p.reply({ t: 'mode', mode: 'full' });
    const inflight = c.load('http://img.test/b.jpg', 10, 10, true, neverStock);
    await Promise.resolve();
    p.fail();
    await expect(inflight).rejects.toThrow('Image worker failed');
    expect(c.stats()).toMatchObject({ failed: 1, mode: 'stock', failedWorker: true });
    expect(p.terminated).toBe(1);
    await expect(c.load('http://img.test/c.jpg', 10, 10, true, stockOk)).resolves.toMatchObject({ data: bm });
    expect(thumbStatsLine(c.stats())).toBe('Renderer loader (worker failed)');
  });

  it('no mode within the startup timeout falls back to stock', async () => {
    const { p, sent } = port();
    let fire: () => void = () => {};
    const c = new ThumbClient(p, {
      startTimeoutMs: 5000,
      setTimer: (fn, ms) => { expect(ms).toBe(5000); fire = fn; return 7; },
      clearTimer: () => {},
    });
    const pending = c.load('http://img.test/d.jpg', 10, 10, true, stockOk);
    fire();
    await expect(pending).resolves.toMatchObject({ data: bm });
    expect(sent).toEqual([]);
    expect(c.stats()).toMatchObject({ mode: 'stock', failedWorker: true });
  });

  it('clears the startup timer when the mode arrives', () => {
    const { p } = port();
    const cleared: unknown[] = [];
    const c = new ThumbClient(p, { setTimer: () => 9, clearTimer: (h) => { cleared.push(h); } });
    p.reply({ t: 'mode', mode: 'full' });
    expect(cleared).toEqual([9]);
    expect(c.stats().failedWorker).toBeUndefined();
  });
});

describe('thumbStatsLine', () => {
  it('reads as one Diagnostics line', () => {
    expect(thumbStatsLine({ stored: 40, fetched: 12, asIs: 3, failed: 1, kept: 11, skipped: 1, mode: 'full' }))
      .toBe('Worker · 40 from device, 12 shrunk, 3 as is, 1 failed · copies kept 11, skipped 1');
    expect(thumbStatsLine({ stored: 0, fetched: 0, asIs: 0, failed: 0, kept: 0, skipped: 0, mode: 'stock' }))
      .toBe('Renderer loader (no worker support)');
    expect(thumbStatsLine({ stored: 0, fetched: 0, asIs: 0, failed: 0, kept: 0, skipped: 0, mode: undefined }))
      .toBe('Starting');
  });
});
