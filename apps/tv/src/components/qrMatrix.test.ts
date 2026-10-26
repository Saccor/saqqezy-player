import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QR_QUIET_MODULES, qrMatrix } from './qrMatrix.ts';

describe('qrMatrix', () => {
  it('encodes a pairing URL at error-correction level M (version 6, 41 modules)', () => {
    const url = `http://localhost:5174/#s=${'A'.repeat(22)}&k=${'B'.repeat(43)}`;
    expect(url.length).toBe(93);
    const m = qrMatrix(url);
    expect(m.size).toBe(41);
    expect(m.dark.length).toBe(41 * 41);
  });

  it('draws the three finder patterns', () => {
    const m = qrMatrix('HELLO');
    expect(m.size).toBe(21);
    const at = (r: number, c: number) => m.dark[r * m.size + c];
    for (const [r, c] of [[0, 0], [0, m.size - 7], [m.size - 7, 0]] as const) {
      expect(at(r, c)).toBe(true);
      expect(at(r + 1, c + 1)).toBe(false);
      expect(at(r + 3, c + 3)).toBe(true);
    }
  });

  it('uses level M: the same short text needs a larger symbol than level L would', () => {
    expect(qrMatrix('x'.repeat(15)).size).toBe(25);
  });

  it('has a 4-module quiet zone', () => {
    expect(QR_QUIET_MODULES).toBe(4);
  });

  it('pairing logic (read by Live TV at start) no longer loads the QR library', () => {
    const src = readFileSync(new URL('../screens/pairingLogic.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/qrcode-generator/);
  });
});
