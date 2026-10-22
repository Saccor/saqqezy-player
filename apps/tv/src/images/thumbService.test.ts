import { describe, expect, it } from 'vitest';
import { createThumbService, type ThumbReply, type ThumbRequest } from './thumbService.ts';
import type { LoadedImage, ThumbDeps } from './thumbLoader.ts';

const req = (id: number): ThumbRequest => ({ t: 'load', id, url: `http://img.test/${id}.jpg`, w: 188, h: 282, alpha: true });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(maxActive = 2) {
  const posts: [ThumbReply, Transferable[] | undefined][] = [];
  const gates: Array<{ id: string; open: (r: LoadedImage) => void; fail: (e: Error) => void }> = [];
  const load = (url: string) => new Promise<LoadedImage>((open, fail) => gates.push({ id: url, open, fail }));
  const svc = createThumbService({
    mode: 'full', deps: {} as ThumbDeps, post: (m, t) => posts.push([m, t]), maxActive,
    load: load as unknown as typeof import('./thumbLoader.ts').loadThumb,
  });
  return { svc, posts, gates };
}
const bitmapLike = { width: 1, height: 1, close() {} } as unknown as ImageBitmap;

describe('thumbService', () => {
  it('announces its mode first', () => {
    const { posts } = setup();
    expect(posts[0]![0]).toEqual({ t: 'mode', mode: 'full' });
  });

  it('answers ok with the bitmap transferred', async () => {
    const { svc, posts, gates } = setup();
    svc.handle(req(1));
    gates[0]!.open({ data: bitmapLike, premultiplyAlpha: true, premultiplied: true, from: 'fetched' });
    await flush();
    expect(posts[1]).toEqual([{ t: 'ok', id: 1, bitmap: bitmapLike, premultiplyAlpha: true, from: 'fetched' }, [bitmapLike]]);
  });

  it('answers err with the message on a failed load', async () => {
    const { svc, posts, gates } = setup();
    svc.handle(req(2));
    gates[0]!.fail(new Error('HTTP 404'));
    await flush();
    expect(posts[1]![0]).toEqual({ t: 'err', id: 2, message: 'HTTP 404' });
  });

  it('runs at most maxActive loads at once, then the queued ones in order', async () => {
    const { svc, gates } = setup(2);
    svc.handle(req(1)); svc.handle(req(2)); svc.handle(req(3));
    expect(gates.map((g) => g.id)).toEqual(['http://img.test/1.jpg', 'http://img.test/2.jpg']);
    gates[0]!.open({ data: bitmapLike, premultiplyAlpha: true, premultiplied: true, from: 'stored' });
    await flush();
    expect(gates.map((g) => g.id)).toEqual(['http://img.test/1.jpg', 'http://img.test/2.jpg', 'http://img.test/3.jpg']);
  });

  it('stock mode answers err "stock"', () => {
    const posts: ThumbReply[] = [];
    const svc = createThumbService({ mode: 'stock', deps: {} as ThumbDeps, post: (m) => posts.push(m) });
    svc.handle(req(5));
    expect(posts).toEqual([{ t: 'mode', mode: 'stock' }, { t: 'err', id: 5, message: 'stock' }]);
  });

  it('answers err when posting the ok reply throws', async () => {
    const posts: ThumbReply[] = [];
    let closed = 0;
    const bitmap = { width: 1, height: 1, close() { closed += 1; } } as unknown as ImageBitmap;
    let gate!: (r: LoadedImage) => void;
    const svc = createThumbService({
      mode: 'full', deps: {} as ThumbDeps,
      post: (m) => { if (m.t === 'ok') throw new Error('DataCloneError'); posts.push(m); },
      load: (() => new Promise<LoadedImage>((o) => { gate = o; })) as unknown as typeof import('./thumbLoader.ts').loadThumb,
    });
    svc.handle(req(9));
    gate({ data: bitmap, premultiplyAlpha: true, premultiplied: true, from: 'fetched' });
    await flush();
    expect(posts).toEqual([{ t: 'mode', mode: 'full' }, { t: 'err', id: 9, message: 'DataCloneError' }]);
    expect(closed).toBe(1);
  });
});
