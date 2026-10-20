import { describe, expect, test } from 'vitest';
import { DEV_USER_AGENT, upstreamHeaders } from './proxyHeaders.ts';

describe('upstreamHeaders (dev proxy)', () => {
  test('identifies as our player, never as the browser, and forwards range only when allowed', () => {
    const req = { 'user-agent': 'Mozilla/5.0 Test', range: 'bytes=0-99', cookie: 'x=1', origin: 'http://localhost:5173' };
    expect(upstreamHeaders(req, true)).toEqual({ 'user-agent': DEV_USER_AGENT, range: 'bytes=0-99' });
    expect(upstreamHeaders(req, false)).toEqual({ 'user-agent': DEV_USER_AGENT });
  });

  test('the user-agent is an honest, stable player identity', () => {
    expect(DEV_USER_AGENT).toMatch(/^SaqqezyPlayer\/\S+/);
    expect(DEV_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|curl/i);
  });

  test('ignores a missing or non-string range', () => {
    expect(upstreamHeaders({}, true)).toEqual({ 'user-agent': DEV_USER_AGENT });
    expect(upstreamHeaders({ 'user-agent': ['a', 'b'], range: undefined }, true)).toEqual({ 'user-agent': DEV_USER_AGENT });
  });

  test('the source headers (ua/ref) replace the default user-agent and add a referer; nothing else changes', () => {
    const req = { 'user-agent': 'Mozilla/5.0 Test', referer: 'http://localhost:5173/', range: 'bytes=0-99' };
    expect(upstreamHeaders(req, true, { userAgent: 'SyntheticAgent/1.0' }))
      .toEqual({ 'user-agent': 'SyntheticAgent/1.0', range: 'bytes=0-99' });
    expect(upstreamHeaders(req, false, { referrer: 'http://ref.example.test/' }))
      .toEqual({ 'user-agent': DEV_USER_AGENT, referer: 'http://ref.example.test/' });
    expect(upstreamHeaders(req, false, { userAgent: 'A/1', referrer: 'http://ref.example.test/' }))
      .toEqual({ 'user-agent': 'A/1', referer: 'http://ref.example.test/' });
  });

  test('with neither, the honest default stays', () => {
    expect(upstreamHeaders({}, false, {})).toEqual({ 'user-agent': DEV_USER_AGENT });
    expect(upstreamHeaders({}, false, undefined)).toEqual({ 'user-agent': DEV_USER_AGENT });
  });
});
