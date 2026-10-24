import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownCountries } from '../../../packages/core/src/text/regions.ts';
// @ts-expect-error plain .mjs without types
import { FLAGS_MAX_BYTES, FLAG_DIR, FLAG_H, FLAG_W, LICENSE_OUT, TEXT_BADGE_COUNTRIES, flagFile } from '../flags.mjs';

const pngSize = (buf: Buffer) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('committed flag images', () => {
  it('one 96 x 72 PNG per country of the detector table, none for disputed territories', () => {
    for (const code of knownCountries()) {
      const path = join(FLAG_DIR, flagFile(code));
      if ((TEXT_BADGE_COUNTRIES as Set<string>).has(code)) { expect(existsSync(path), code).toBe(false); continue; }
      expect(existsSync(path), code).toBe(true);
      const buf = readFileSync(path);
      expect(buf.subarray(0, 8).equals(SIGNATURE), code).toBe(true);
      expect(pngSize(buf), code).toEqual({ w: FLAG_W, h: FLAG_H });
    }
  });

  it('nothing else in the folder, within the size budget, and the licence ships', () => {
    const known = new Set(knownCountries().map((c) => flagFile(c)));
    const pngs = readdirSync(FLAG_DIR).filter((f) => f.endsWith('.png'));
    for (const f of pngs) expect(known.has(f), f).toBe(true);
    const total = pngs.reduce((n, f) => n + readFileSync(join(FLAG_DIR, f)).length, 0);
    expect(total).toBeLessThan(FLAGS_MAX_BYTES);
    expect(readFileSync(LICENSE_OUT, 'utf8')).toMatch(/MIT/);
  });
});
