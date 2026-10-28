/**
 * Hybrid logical clock (Kulkarni et al.): wall-clock milliseconds plus a counter for events within one millisecond (or
 * while the wall clock stands still or goes backwards), plus the node id that breaks ties between devices.
 *
 * Encoded as a fixed-width string, `wall` (9 base-36 digits) + `counter` (2 base-36 digits) + `node` (6 characters
 * [0-9a-z]), so plain string comparison is clock order. 17 characters per stamp keeps payloads small.
 */
export interface Hlc { wall: number; counter: number; node: string }

/** Highest counter (two base-36 digits); one more moves the clock to the next millisecond. */
export const HLC_COUNTER_MAX = 36 * 36 - 1;
/** A remote stamp is never taken to be more than this far ahead of the local wall clock (§6.2). */
export const HLC_MAX_DRIFT_MS = 24 * 3600_000;
const WALL_DIGITS = 9;
const COUNTER_DIGITS = 2;
const NODE_RE = /^[0-9a-z]{6}$/;
const STAMP_RE = /^[0-9a-z]{17}$/;

export const isNodeId = (x: unknown): x is string => typeof x === 'string' && NODE_RE.test(x);

export function encodeHlc(h: Hlc): string {
  return h.wall.toString(36).padStart(WALL_DIGITS, '0') + h.counter.toString(36).padStart(COUNTER_DIGITS, '0') + h.node;
}

export function decodeHlc(s: string): Hlc | undefined {
  if (typeof s !== 'string' || !STAMP_RE.test(s)) return undefined;
  const wall = parseInt(s.slice(0, WALL_DIGITS), 36);
  const counter = parseInt(s.slice(WALL_DIGITS, WALL_DIGITS + COUNTER_DIGITS), 36);
  return { wall, counter, node: s.slice(WALL_DIGITS + COUNTER_DIGITS) };
}

export const isHlc = (x: unknown): x is string => typeof x === 'string' && STAMP_RE.test(x);

/** Wall time of an encoded stamp (ms). */
export const hlcWall = (s: string): number => parseInt(s.slice(0, WALL_DIGITS), 36);

/** Clock order of two encoded stamps; a missing stamp is older than any stamp. */
export function compareHlc(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a < b ? -1 : 1;
}

function bump(wall: number, counter: number, node: string): Hlc {
  return counter > HLC_COUNTER_MAX ? { wall: wall + 1, counter: 0, node } : { wall, counter, node };
}

/** The next local stamp: never earlier than `last`, even when the wall clock went backwards. */
export function tickHlc(last: Hlc | undefined, now: number, node: string): Hlc {
  if (!last || now > last.wall) return { wall: now, counter: 0, node };
  return bump(last.wall, last.counter + 1, node);
}

/** A remote stamp with its wall time capped at `now + HLC_MAX_DRIFT_MS` (a device with a wrong clock cannot win for ever). */
export function clampRemote(remote: Hlc, now: number): Hlc {
  const max = now + HLC_MAX_DRIFT_MS;
  return remote.wall > max ? { wall: max, counter: 0, node: remote.node } : remote;
}

/** The local clock after seeing a remote stamp (clamped first): later than both `last` and the remote stamp. */
export function receiveHlc(last: Hlc | undefined, remote: Hlc, now: number, node: string): Hlc {
  const r = clampRemote(remote, now);
  const lw = last?.wall ?? -1;
  const wall = Math.max(lw, r.wall, now);
  let counter: number;
  if (wall === lw && wall === r.wall) counter = Math.max(last!.counter, r.counter) + 1;
  else if (wall === lw) counter = last!.counter + 1;
  else if (wall === r.wall) counter = r.counter + 1;
  else counter = 0;
  return bump(wall, counter, node);
}
