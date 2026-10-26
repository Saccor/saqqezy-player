import qrcode from 'qrcode-generator';
import type { CompanionStatus } from '@iptv/app-api';
import { SETTINGS_COPY } from '../copy.ts';

/**
 * Pure logic of the "Phone and computer" page: copy, countdown, actions and the QR matrix.
 * The pairing URL and code are secrets: they are drawn, never logged or persisted.
 */

const PH = SETTINGS_COPY.phone;

export type PairingMode = 'qr' | 'code';
export type PairingState = CompanionStatus['state'];

/** What the page is showing for the current session (kept in module memory across visits). */
export interface ShownPairing {
  mode: PairingMode;
  qrUrl?: string;
  code?: string;
  expiresAt: number;
}

/** `mm:ss`, rounding partial seconds up so the last second shows 00:01; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** The line under the status: what ends, and when. Empty without a live session. */
export function countdownLine(status: CompanionStatus, now: number): string {
  if (status.expiresAt === undefined || !isPairingActive(status.state)) return '';
  const left = formatCountdown(status.expiresAt - now);
  return status.state === 'waiting' ? PH.expiresIn(left) : PH.endsIn(left);
}

export const PEER_LABEL_MAX = 32;

/**
 * The companion's self-reported label is untrusted text: control characters are dropped, runs of whitespace
 * become one space (a `Text` node clips text with double spaces) and it is capped at PEER_LABEL_MAX.
 */
export function cleanPeerLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const s = label.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > PEER_LABEL_MAX ? `${s.slice(0, PEER_LABEL_MAX - 1)}…` : s;
}

/** The status line for a companion status. */
export function statusCopy(status: CompanionStatus, mode: PairingMode): string {
  switch (status.state) {
    case 'waiting':
      return mode === 'qr' ? PH.scan : PH.typeCode;
    case 'connected': {
      const label = cleanPeerLabel(status.peerLabel);
      return label ? PH.connectedTo(label) : PH.connectedPlain;
    }
    case 'reconnecting':
      return PH.reconnecting;
    case 'expired':
      return endedCopy(status.reason);
    case 'idle':
      return PH.disconnected;
  }
}

/** Why a session ended, in one short line (the page still offers Show a new code). */
function endedCopy(reason: CompanionStatus['reason']): string {
  switch (reason) {
    case undefined:
    case 'expired':
      return PH.expired;
    case 'replaced':
      return PH.replaced;
    case 'rate-limit':
    case 'quota':
      return PH.tooMuch;
    case 'unreachable':
      return PH.lost;
    case 'peer-errors':
      return PH.problem;
    case 'stopped':
      return PH.ended;
  }
}

export function isPairingActive(state: PairingState): boolean {
  return state === 'waiting' || state === 'connected' || state === 'reconnecting';
}

/** Status events for a session that just ended can arrive right after `companionStart` resolved for the next one. */
export const START_GRACE_MS = 250;

/**
 * Whether the shown QR/code should be forgotten after a status change. Only when no session is live, no start
 * is running, and the change is not a stale `idle`/`expired` of the previous session landing within
 * START_GRACE_MS of the current start's successful result (`startedAt`, `undefined` before it succeeded).
 */
export function shouldForgetPairing(
  state: PairingState, starting: boolean, startedAt: number | undefined, now: number,
): boolean {
  if (isPairingActive(state) || starting) return false;
  return startedAt === undefined || now - startedAt >= START_GRACE_MS;
}

/** Home shows the "Phone" badge only while a companion is actually connected. */
export function showPhoneBadge(status: CompanionStatus | undefined): boolean {
  return status?.state === 'connected';
}

/**
 * Reopening the page must not replace a live session: a paired one is always kept; a waiting one is kept
 * when the page still has its QR URL or code to show (otherwise a fresh code is started).
 */
export function shouldReuseSession(status: CompanionStatus, shown: ShownPairing | undefined): boolean {
  if (status.state === 'connected' || status.state === 'reconnecting') return true;
  return status.state === 'waiting' && shown !== undefined;
}

export type PairingActionId = 'toggleMode' | 'newCode' | 'disconnect';
export interface PairingAction { id: PairingActionId; label: string }

/**
 * The page's buttons. Waiting: switch mode, new code, disconnect. Paired: only disconnect (a new code would
 * drop the phone). Ended (expired or disconnected): a new code first, always.
 */
export function pairingActions(state: PairingState, mode: PairingMode): PairingAction[] {
  const toggle: PairingAction = { id: 'toggleMode', label: mode === 'qr' ? PH.useCodeButton : PH.showQrInstead };
  const newCode: PairingAction = { id: 'newCode', label: PH.newCode };
  const disconnect: PairingAction = { id: 'disconnect', label: PH.disconnect };
  switch (state) {
    case 'waiting': return [toggle, newCode, disconnect];
    case 'connected':
    case 'reconnecting': return [disconnect];
    default: return [newCode, toggle];
  }
}

/** A QR symbol: `size` x `size` modules, row-major, true = dark. No quiet zone. */
export interface QrMatrix { size: number; dark: boolean[] }

/** Encodes text (byte mode, smallest version that fits) at error-correction level M. */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const dark: boolean[] = new Array<boolean>(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark[r * size + c] = qr.isDark(r, c);
  }
  return { size, dark };
}

/** Quiet zone around the symbol, in modules (the QR spec asks for 4). */
export const QR_QUIET_MODULES = 4;

/** The pointer-mode button that replaces the Yellow hint under the QR code or the code. */
export function toggleButtonLabel(mode: PairingMode): string {
  return mode === 'qr' ? PH.useCodeButton : PH.showQrButton;
}
