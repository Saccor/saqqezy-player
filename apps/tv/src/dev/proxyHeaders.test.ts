import { describe, expect, test } from 'vitest';
import { upstreamHeaders } from './proxyHeaders.ts';

describe('upstreamHeaders (dev proxy)', () => {
  test('forwards the browser user-agent, and range only when allowed', () => {
    const req = { 'user-agent': 'Mozilla/5.0 Test', range: 'bytes=0-99', cookie: 'x=1', origin: 'http://localhost:5173' };
    expect(upstreamHeaders(req, true)).toEqual({ 'user-agent': 'Mozilla/5.0 Test', range: 'bytes=0-99' });
    expect(upstreamHeaders(req, false)).toEqual({ 'user-agent': 'Mozilla/5.0 Test' });
  });

  test('ignores missing or non-string values', () => {
    expect(upstreamHeaders({}, true)).toEqual({});
    expect(upstreamHeaders({ 'user-agent': ['a', 'b'], range: undefined }, true)).toEqual({});
  });
});
