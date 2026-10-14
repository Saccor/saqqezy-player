import { describe, expect, it } from 'vitest';
import { buildHeaders, DEV_RELAY_URL, relayOrigin } from './headers.ts';

const csp = (headers: string) => /Content-Security-Policy: (.*)/.exec(headers)![1]!;
const connectSrc = (headers: string) => /connect-src ([^;]*)/.exec(csp(headers))![1]!;

describe('_headers generation', () => {
  it('puts the relay origin (no path or query) in connect-src', () => {
    const h = buildHeaders('wss://relay.example.test/some/path?x=1');
    expect(connectSrc(h)).toBe("'self' wss://relay.example.test");
    expect(h).not.toContain('PLACEHOLDER');
    expect(h).not.toContain('127.0.0.1');
  });

  it('falls back to the dev relay when VITE_RELAY_URL is unset or empty', () => {
    expect(connectSrc(buildHeaders(undefined))).toBe("'self' ws://127.0.0.1:8787");
    expect(connectSrc(buildHeaders(''))).toBe(`'self' ${DEV_RELAY_URL}`);
  });

  it('keeps the port and the rest of the policy and headers', () => {
    const h = buildHeaders('ws://localhost:9999');
    expect(connectSrc(h)).toBe("'self' ws://localhost:9999");
    expect(csp(h)).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://localhost:9999; "
      + "img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(h).toMatch(/^\/\*$/m);
    expect(h).toContain('  Referrer-Policy: no-referrer');
    expect(h).toContain('  X-Content-Type-Options: nosniff');
  });

  it('refuses a relay URL that is not ws: or wss:', () => {
    expect(() => relayOrigin('https://relay.example.test')).toThrow(/ws/);
    expect(() => relayOrigin('not a url')).toThrow();
  });
});
