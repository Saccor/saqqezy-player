import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { trendingBaseUrl } from './trendingConfig.ts';

/** `apps/tv/.env.production` as Vite reads it (KEY=value lines; # comments). */
function prodEnv(): Record<string, string> {
  const text = readFileSync(new URL('../../.env.production', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

describe('.env.production', () => {
  test('points production builds at the public trending feed over https', () => {
    const env = prodEnv();
    const url = trendingBaseUrl({ VITE_TRENDING_URL: env.VITE_TRENDING_URL, DEV: false });
    expect(url).toMatch(/^https:\/\/[^/]+\/trending$/);
  });

  test('holds public addresses only: no key, token or secret variables', () => {
    for (const name of Object.keys(prodEnv())) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/i);
  });
});
