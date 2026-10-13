import { afterEach, describe, expect, test } from 'vitest';
import { SourceAuthError, SourceNetworkError } from '@iptv/core';
import { expose, wrap, type Remote } from '../src/rpc.ts';

class Api {
  add(a: number, b: number) { return a + b; }
  async slow(ms: number, v: string) { await new Promise((r) => setTimeout(r, ms)); return v; }
  fail() { throw new SourceAuthError(); }
  async netFail() { throw new SourceNetworkError('boom', 503); }
}

let channel: MessageChannel;
afterEach(() => { channel.port1.close(); channel.port2.close(); });

function setup() {
  channel = new MessageChannel();
  const host = expose(new Api(), channel.port1);
  const client = wrap<Api>(channel.port2);
  return { host, client };
}

describe('rpc', () => {
  test('round trip', async () => {
    const { client } = setup();
    const api: Remote<Api> = client.api;
    expect(await api.add(2, 3)).toBe(5);
  });

  test('errors keep name, message and status', async () => {
    const { client } = setup();
    const e1 = await client.api.fail().catch((e: unknown) => e) as Error;
    expect(e1).toBeInstanceOf(Error);
    expect(e1.name).toBe('SourceAuthError');
    expect(e1.message).toMatch(/rejected the login/);
    const e2 = await client.api.netFail().catch((e: unknown) => e) as Error & { status?: number };
    expect(e2.name).toBe('SourceNetworkError');
    expect(e2.status).toBe(503);
  });

  test('events reach subscribers until unsubscribed', async () => {
    const { host, client } = setup();
    const got: unknown[] = [];
    const off = client.on('tick', (p) => got.push(p));
    host.emit('tick', 1);
    host.emit('other', 9);
    await new Promise((r) => setTimeout(r, 20));
    off();
    host.emit('tick', 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([1]);
  });

  test('unknown method rejects with RpcError', async () => {
    const { client } = setup();
    const loose = client.api as unknown as Record<string, () => Promise<unknown>>;
    const err = await loose.nope!().catch((e: unknown) => e) as Error;
    expect(err.name).toBe('RpcError');
    const proto = await loose.constructor!().catch((e: unknown) => e) as Error;
    expect(proto.name).toBe('RpcError');
  });

  test('concurrent calls resolve by id regardless of completion order', async () => {
    const { client } = setup();
    const [a, b, c] = await Promise.all([client.api.slow(60, 'a'), client.api.slow(10, 'b'), client.api.slow(30, 'c')]);
    expect([a, b, c]).toEqual(['a', 'b', 'c']);
  });
});
