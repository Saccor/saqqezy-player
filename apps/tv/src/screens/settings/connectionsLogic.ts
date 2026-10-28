import type { JournalEvent } from '@iptv/player';
import { SETTINGS_COPY } from '../../copy.ts';
import { eventText, logTime } from '../journalLogic.ts';

const CC = SETTINGS_COPY.connections;

/**
 * Diagnostics → Connections (spec 2026-10-20-multiview §5.7, owner decision §12.10): what the owner reads back after
 * running the 1–4 window test on his own account. Numbers, times and window numbers only; never URLs, hosts or
 * channel names. Pure.
 */
export interface ConnectionsFacts {
  /** The source's reported connection count (Xtream `max_connections`), when known. */
  reported?: number;
  /** Connections in use at the last sign-in (Xtream `active_cons`), when known. */
  activeAtLogin?: number;
  /** Most windows seen playing at once on this device. */
  maxSeen: number;
  /** The lowest window number the source refused or cut. */
  refusedAt?: number;
}

/** The kinds a multiview window logs about its connection. */
const KINDS = new Set(['open', 'playing', 'tileRefused', 'displaced', 'pingPong', 'escalated', 'failed', 'stop']);

export function connectionsHeader(f: ConnectionsFacts): [string, string][] {
  const out: [string, string][] = [
    [CC.reports, f.reported === undefined ? CC.noLimit : CC.connectionCount(f.reported)],
  ];
  if (f.activeAtLogin !== undefined) out.push([CC.inUse, String(f.activeAtLogin)]);
  out.push([CC.maxSeen, String(f.maxSeen)]);
  if (f.refusedAt !== undefined) out.push([CC.refusedAt, CC.windowN(f.refusedAt)]);
  return out;
}

/** The windows' connection events, newest first. */
export function connectionsRows(events: readonly JournalEvent[], now: number): { id: string; time: string; text: string }[] {
  const rows: { id: string; time: string; text: string }[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.tile === undefined || !KINDS.has(e.k)) continue;
    rows.push({ id: `c${i}`, time: logTime(e.t, now), text: eventText(e) });
  }
  return rows;
}

/** The readout as plain text (Copy), header first. */
export function connectionsText(f: ConnectionsFacts, events: readonly JournalEvent[], now: number): string {
  const head = connectionsHeader(f).map(([k, v]) => `${k}: ${v}`);
  const rows = connectionsRows(events, now).map((r) => `${r.time}  ${r.text}`);
  return [...head, '', ...(rows.length > 0 ? rows : [CC.none])].join('\n');
}
