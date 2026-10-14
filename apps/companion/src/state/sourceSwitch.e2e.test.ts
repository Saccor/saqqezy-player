/**
 * End to end, in memory: the real TV side (AppApi + CompanionHost) and the real companion (store, client, ops
 * sender) over a fake relay socket. The TV switches source while the phone still shows the old one; the phone's
 * stale ops are rejected (WrongSource), it resyncs and shows the new source's layout, and its next edit lands on
 * the new source.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SourceService, type FetchFn } from '@iptv/core';
import { MemoryStorage } from '@iptv/storage';
import { AppApi, CompanionHost } from '@iptv/app-api';
import { secretsFromQrFragment, type FrameTransport } from '@iptv/companion-protocol';

/** A WebSocket stand-in that opens on its own; what the phone sends goes to `FakeWs.toTv`. */
class FakeWs extends EventTarget {
  static current: FakeWs | undefined;
  static toTv: ((f: Uint8Array) => void) | undefined;
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeWs.current = this;
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      this.onopen?.({});
    }, 0);
  }
  send(d: Uint8Array): void {
    if (d.byteLength > 0) {
      const copy = d.slice();
      setTimeout(() => FakeWs.toTv?.(copy), 0);
    }
  }
  close(): void {
    this.readyState = 3;
  }
}

vi.stubGlobal('WebSocket', FakeWs);
vi.stubGlobal('document', { visibilityState: 'visible' });

const { connect, store, layout, channels, onPageHide } = await import('./store.ts');
const { sendOps } = await import('./actions.ts');

const playlist = (prefix: string, groups: string[]) => ['#EXTM3U', ...groups.flatMap((g, i) => [
  `#EXTINF:-1 tvg-id="${prefix}${i}.test" group-title="${g}",${prefix} channel ${i}`,
  `http://example.test/live/${prefix}${i}.ts`,
]), ''].join('\n');
const LISTS: Record<string, string> = {
  'http://example.test/a.m3u': playlist('a', ['Alpha news', 'Alpha films']),
  'http://example.test/b.m3u': playlist('b', ['Beta kids', 'Beta music', 'Beta docs']),
};
const fetchFn: FetchFn = async (u) => {
  const body = LISTS[u];
  return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
};

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('companion end to end: the TV switches source', () => {
  let api: AppApi;
  let host!: CompanionHost;

  beforeAll(() => {
    const storage = new MemoryStorage();
    const service = new SourceService({ storage, fetch: fetchFn, now: () => Date.UTC(2026, 9, 14, 12) });
    api = new AppApi({
      service, storage, emit: () => {},
      companion: (a, onStatus) => (host = new CompanionHost({
        api: a, tvLabel: 'Test TV', appVersion: '1.1.0', companionOrigin: 'https://manage.example.test', onStatus,
        openTransport: () => {
          const listeners = new Set<(f: Uint8Array) => void>();
          FakeWs.toTv = (f) => { for (const fn of [...listeners]) fn(f); };
          const t: FrameTransport = {
            send: (f) => {
              const copy = f.slice();
              setTimeout(() => {
                const ws = FakeWs.current;
                if (ws && ws.readyState === 1) ws.onmessage?.({ data: copy.buffer });
              }, 0);
            },
            onFrame: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
            close: () => {},
          };
          return t;
        },
      })),
    });
  });

  afterAll(async () => {
    onPageHide();
    host.stop();
    await api.idle();
  });

  it('rejects the stale ops, resyncs to the new source and edits land on it', async () => {
    const { sourceId: a } = await api.addSource({ kind: 'm3u', name: 'Source A', playlistUrl: 'http://example.test/a.m3u' });
    const { sourceId: b } = await api.addSource({ kind: 'm3u', name: 'Source B', playlistUrl: 'http://example.test/b.m3u' });
    await api.idle();
    // B has its own layout (a list made on the TV earlier), so "B's layout" is recognisable on the phone.
    await api.setActiveSource(b);
    await api.applyLayoutOps([{ op: 'createList', id: 'b-list', name: 'Made for B' }]);
    await api.setActiveSource(a);
    await api.idle();

    const started = await host.start('qr');
    const secrets = await secretsFromQrFragment(started.qrUrl!.slice(started.qrUrl!.indexOf('#')));
    connect(secrets);
    await until(() => store.state?.activeSourceId === a, 'the state of source A');
    expect(channels().map((c) => c.name)).toContain('a channel 0');
    expect(store.state!.groups.map((g) => g.name).sort()).toEqual(['Alpha films', 'Alpha news']);

    // The TV switches to B; before its state push reaches the phone, the phone edits A's layout.
    await api.setActiveSource(b);
    const err = await sendOps([{ op: 'createList', id: 'stale', name: 'Stale' }]);
    expect(err).toBe('The TV switched to another source.');
    // Nothing of the stale change is left on the phone, and nothing landed on the TV.
    expect(layout()?.lists.some((l) => l.id === 'stale') ?? false).toBe(false);
    expect((await api.getLayout()).lists.some((l) => l.id === 'stale')).toBe(false);

    // The phone resyncs and shows B: its groups and its lists.
    await until(() => store.state?.activeSourceId === b, 'the state of source B');
    expect(store.state!.groups.map((g) => g.name).sort()).toEqual(['Beta docs', 'Beta kids', 'Beta music']);
    expect(layout()!.lists.map((l) => l.id)).toContain('b-list');
    expect(channels().map((c) => c.name)).toContain('b channel 0');

    // The next edit goes to B.
    expect(await sendOps([{ op: 'createList', id: 'phone-list', name: 'From the phone' }])).toBeUndefined();
    const onTv = await api.getActiveLayout();
    expect(onTv.sourceId).toBe(b);
    expect(onTv.layout.lists.map((l) => l.id)).toContain('phone-list');
    await until(() => layout()?.lists.some((l) => l.id === 'phone-list') === true, 'the pushed layout');

    // A was never touched by the phone.
    await api.setActiveSource(a);
    expect((await api.getLayout()).lists.map((l) => l.id)).toEqual(['fav']);
    // A switch on the TV alone (no request from the phone) reaches the phone as a pushed state.
    await until(() => store.state?.activeSourceId === a, 'the pushed state of source A');
    expect(layout()!.lists.map((l) => l.id)).toEqual(['fav']);
  });
});
