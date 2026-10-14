import { afterEach, describe, expect, test } from 'vitest';
import { SourceAuthError, SourceNetworkError } from '@iptv/core';
import { expose, wrap, type Remote } from '../src/rpc.ts';

class Api {
  add(a: number, b: number) { return a + b; }
  async slow(ms: number, v: string) { await new Promise((r) => setTimeout(r, ms)); return v; }
  fail() { throw new SourceAuthError(); }
  async netFail() { throw new SourceNetworkError('boom', 503); }
  fnResult() { return () => 1; }
  secret() { return 'internal'; }
}

let channel: MessageChannel;
afterEach(() => { channel.port1.close(); channel.port2.close(); });

function setup(methods?: readonly string[]) {
  channel = new MessageChannel();
  const host = expose(new Api(), channel.port1, methods);
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

  test('a result that cannot be cloned rejects with RpcError instead of hanging', async () => {
    const { client } = setup();
    const err = await client.api.fnResult().catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RpcError');
    expect(err.message).toBe('Result could not be sent');
    expect(await client.api.add(1, 1)).toBe(2);
  });

  test('a throwing listener does not stop delivery to the others', async () => {
    const { host, client } = setup();
    const got: unknown[] = [];
    client.on('tick', () => { throw new Error('listener bug'); });
    client.on('tick', (p) => got.push(p));
    host.emit('tick', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([1]);
  });

  test('dispose rejects pending and later calls with Worker terminated', async () => {
    const { client } = setup();
    const pending = client.api.slow(200, 'x').catch((e: unknown) => e) as Promise<Error>;
    client.dispose();
    const err = await pending;
    expect(err.name).toBe('RpcError');
    expect(err.message).toBe('Worker terminated');
    const later = await client.api.add(1, 2).catch((e: unknown) => e) as Error;
    expect(later.name).toBe('RpcError');
    expect(later.message).toBe('Worker terminated');
  });

  test('an allowlist limits which methods are callable', async () => {
    const { client } = setup(['add', 'slow']);
    expect(await client.api.add(1, 2)).toBe(3);
    const err = await client.api.secret().catch((e: unknown) => e) as Error;
    expect(err.name).toBe('RpcError');
  });
});
