import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bakedValues, checkProdEnv, missingProdEnv, prodEnvCheck, prodEnvMessage, strictProdEnv, viteEnv,
} from '../prodEnv.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('production env check', () => {
  it('the TV needs the relay and the companion origin; the companion only the relay; empty counts as unset', () => {
    expect(missingProdEnv('tv', {})).toEqual(['VITE_RELAY_URL', 'VITE_COMPANION_ORIGIN']);
    expect(missingProdEnv('tv', { VITE_RELAY_URL: 'wss://relay.example.test', VITE_COMPANION_ORIGIN: '  ' }))
      .toEqual(['VITE_COMPANION_ORIGIN']);
    expect(missingProdEnv('companion', { VITE_RELAY_URL: 'wss://relay.example.test' })).toEqual([]);
    expect(missingProdEnv('companion', { VITE_COMPANION_ORIGIN: 'https://manage.example.test' })).toEqual(['VITE_RELAY_URL']);
  });

  it('warns loudly, naming each missing variable and its dev default', () => {
    const warn = vi.fn();
    expect(checkProdEnv('tv', { VITE_RELAY_URL: 'wss://relay.example.test' }, { strict: false, warn })).toEqual(['VITE_COMPANION_ORIGIN']);
    const text = warn.mock.calls[0]![0] as string;
    expect(text).toContain('WARNING');
    expect(text).toContain('VITE_COMPANION_ORIGIN is not set');
    expect(text).toContain('http://localhost:5174');
    expect(text).toContain('REQUIRE_PROD_ENV=1');
    expect(text).not.toContain('VITE_RELAY_URL is not set');
  });

  it('is quiet when everything is set', () => {
    const warn = vi.fn();
    checkProdEnv('tv', { VITE_RELAY_URL: 'wss://r.example.test', VITE_COMPANION_ORIGIN: 'https://m.example.test' }, { strict: true, warn });
    expect(warn).not.toHaveBeenCalled();
    expect(prodEnvMessage('tv', [], true)).toBeUndefined();
  });

  it('REQUIRE_PROD_ENV=1 turns the warning into an error', () => {
    expect(strictProdEnv({ REQUIRE_PROD_ENV: '1' })).toBe(true);
    expect(strictProdEnv({ REQUIRE_PROD_ENV: 'true' })).toBe(true);
    expect(strictProdEnv({})).toBe(false);
    expect(strictProdEnv({ REQUIRE_PROD_ENV: '0' })).toBe(false);
    expect(() => checkProdEnv('companion', {}, { strict: true })).toThrow(/ERROR[\s\S]*VITE_RELAY_URL is not set/);
  });

  it('the Vite plugin checks production builds only', () => {
    vi.stubEnv('REQUIRE_PROD_ENV', '1');
    vi.stubEnv('VITE_RELAY_URL', '');
    const plugin = prodEnvCheck('companion');
    expect(plugin.apply).toBe('build');
    expect(() => plugin.configResolved({ isProduction: false, env: {} })).not.toThrow();
    expect(() => plugin.configResolved({ isProduction: true, env: {} })).toThrow(/VITE_RELAY_URL/);
    expect(() => plugin.configResolved({ isProduction: true, env: { VITE_RELAY_URL: 'wss://r.example.test' } })).not.toThrow();
  });

  it('bakedValues prints the configured values, or the dev default marked as such', () => {
    expect(bakedValues('tv', { VITE_RELAY_URL: 'wss://r.example.test' })).toEqual([
      'VITE_RELAY_URL=wss://r.example.test',
      'VITE_COMPANION_ORIGIN=http://localhost:5174  (unset: dev default)',
    ]);
  });

  it('viteEnv reads the .env files a production build sees; the process environment wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-env-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), 'VITE_RELAY_URL=ws://from-env.example.test\nOTHER=x\n');
    writeFileSync(join(dir, '.env.production'), 'VITE_COMPANION_ORIGIN="https://m.example.test"\n');
    writeFileSync(join(dir, '.env.development'), 'VITE_COMPANION_ORIGIN=http://dev.example.test\n');
    expect(viteEnv(dir, 'production', {})).toEqual({
      VITE_RELAY_URL: 'ws://from-env.example.test', VITE_COMPANION_ORIGIN: 'https://m.example.test',
    });
    expect(viteEnv(dir, 'production', { VITE_RELAY_URL: 'wss://r.example.test', PATH: '/bin' }).VITE_RELAY_URL)
      .toBe('wss://r.example.test');
  });
});
