import { describe, expect, it } from 'vitest';
import {
  PEER_LABEL_MAX, cleanPeerLabel, countdownLine, formatCountdown, isPairingActive, pairingActions, qrMatrix,
  shouldReuseSession, showPhoneBadge, statusCopy,
} from './pairingLogic.ts';

describe('formatCountdown', () => {
  it('formats mm:ss, rounding partial seconds up', () => {
    expect(formatCountdown(15 * 60_000)).toBe('15:00');
    expect(formatCountdown(14 * 60_000 + 59_001)).toBe('15:00');
    expect(formatCountdown(61_000)).toBe('01:01');
    expect(formatCountdown(9_500)).toBe('00:10');
    expect(formatCountdown(1)).toBe('00:01');
  });

  it('never goes below 00:00', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
  });

  it('shows 60 minutes as 60:00', () => {
    expect(formatCountdown(60 * 60_000)).toBe('60:00');
  });
});

describe('countdownLine', () => {
  it('names what ends: the code while waiting, the session once connected', () => {
    expect(countdownLine({ state: 'waiting', expiresAt: 70_000 }, 10_000)).toBe('Code expires in 01:00');
    expect(countdownLine({ state: 'connected', expiresAt: 70_000 }, 10_000)).toBe('Session ends in 01:00');
    expect(countdownLine({ state: 'reconnecting', expiresAt: 70_000 }, 10_000)).toBe('Session ends in 01:00');
  });

  it('is empty without a live session', () => {
    expect(countdownLine({ state: 'expired' }, 0)).toBe('');
    expect(countdownLine({ state: 'idle' }, 0)).toBe('');
    expect(countdownLine({ state: 'waiting' }, 0)).toBe('');
  });
});

describe('statusCopy', () => {
  it('maps every status to neutral copy', () => {
    expect(statusCopy({ state: 'waiting' }, 'qr')).toBe("Open your phone's camera and scan the code.");
    expect(statusCopy({ state: 'connected', peerLabel: 'Phone' }, 'qr')).toBe('Connected: Phone');
    expect(statusCopy({ state: 'connected' }, 'qr')).toBe('Connected');
    expect(statusCopy({ state: 'reconnecting' }, 'qr')).toBe('Reconnecting…');
    expect(statusCopy({ state: 'expired' }, 'qr')).toBe('This code has expired.');
    expect(statusCopy({ state: 'idle' }, 'qr')).toBe('Disconnected.');
  });

  it('asks for the code in code mode', () => {
    expect(statusCopy({ state: 'waiting' }, 'code')).toBe('Type this code on your phone or computer.');
  });

  it('cleans the peer label it shows', () => {
    expect(statusCopy({ state: 'connected', peerLabel: '  My\u0000  phone\n ' }, 'qr')).toBe('Connected: My phone');
  });
});

describe('cleanPeerLabel', () => {
  it('drops control characters, collapses spaces and caps the length', () => {
    expect(cleanPeerLabel('a\u0007b   c')).toBe('ab c');
    expect(cleanPeerLabel('   ')).toBeUndefined();
    expect(cleanPeerLabel(undefined)).toBeUndefined();
    const long = cleanPeerLabel('x'.repeat(100));
    expect(long?.length).toBe(PEER_LABEL_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('pairingActions', () => {
  it('offers a mode switch, a new code and disconnect while waiting', () => {
    expect(pairingActions('waiting', 'qr').map((a) => a.label)).toEqual(['Use a code instead', 'Show a new code', 'Disconnect']);
    expect(pairingActions('waiting', 'code').map((a) => a.id)).toEqual(['toggleMode', 'newCode', 'disconnect']);
    expect(pairingActions('waiting', 'code')[0]?.label).toBe('Show the QR code instead');
  });

  it('offers only disconnect while a phone is paired', () => {
    expect(pairingActions('connected', 'qr').map((a) => a.id)).toEqual(['disconnect']);
    expect(pairingActions('reconnecting', 'code').map((a) => a.id)).toEqual(['disconnect']);
  });

  it('always offers a new code once the session ended', () => {
    expect(pairingActions('expired', 'qr').map((a) => a.id)).toEqual(['newCode', 'toggleMode']);
    expect(pairingActions('idle', 'code').map((a) => a.id)).toEqual(['newCode', 'toggleMode']);
  });
});

describe('session helpers', () => {
  it('knows which states are live', () => {
    expect(isPairingActive('waiting')).toBe(true);
    expect(isPairingActive('connected')).toBe(true);
    expect(isPairingActive('reconnecting')).toBe(true);
    expect(isPairingActive('expired')).toBe(false);
    expect(isPairingActive('idle')).toBe(false);
  });

  it('shows the Home badge only while connected', () => {
    expect(showPhoneBadge({ state: 'connected' })).toBe(true);
    expect(showPhoneBadge({ state: 'reconnecting' })).toBe(false);
    expect(showPhoneBadge({ state: 'waiting' })).toBe(false);
    expect(showPhoneBadge(undefined)).toBe(false);
  });

  it('reuses a live session on reopen instead of replacing it', () => {
    const shown = { mode: 'qr' as const, qrUrl: 'http://localhost:5174/#s=a&k=b', expiresAt: 5 };
    expect(shouldReuseSession({ state: 'connected' }, undefined)).toBe(true);
    expect(shouldReuseSession({ state: 'reconnecting' }, undefined)).toBe(true);
    expect(shouldReuseSession({ state: 'waiting' }, shown)).toBe(true);
    // Waiting, but this screen no longer has the secrets to show: start again.
    expect(shouldReuseSession({ state: 'waiting' }, undefined)).toBe(false);
    expect(shouldReuseSession({ state: 'expired' }, shown)).toBe(false);
    expect(shouldReuseSession({ state: 'idle' }, shown)).toBe(false);
  });
});

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
    // 15 bytes fit version 1 at L (17 bytes) but not at M (14 bytes).
    expect(qrMatrix('x'.repeat(15)).size).toBe(25);
  });
});
