/**
 * Catch-up URL templates (spec 2026-10-20-catch-up §1.3): the Kodi-compatible placeholder set. Anything outside it
 * makes the template invalid, so the app never builds a wrong URL silently.
 */
import { zeroPad as pad } from '../text/pad.ts';
import { wallClock, type CatchupZone, type WallClock } from './zone.ts';

/** Programme times (the displayed ones) and the current time, in ms. */
export interface TemplateTimes { start: number; stop: number; now: number }

type Part =
  | { lit: string }
  | { name: string; arg?: string; query: boolean };

const UNIX = new Set(['utc', 'start', 'utcend', 'end', 'lutc', 'now', 'timestamp']);
const FMT_OK = new Set(['utc', 'start', 'utcend', 'end']);
const DIV_OK = new Set(['duration', 'offset']);
const WALL = new Set(['Y', 'm', 'd', 'H', 'M', 'S']);
const FMT_RE = /^[YmdHMS\-:/._ ]+$/;
const DIV_RE = /^[1-9]\d*$/;

const parsed = new Map<string, Part[] | null>();

function validPart(name: string, arg: string | undefined): boolean {
  if (arg === undefined) return UNIX.has(name) || DIV_OK.has(name) || WALL.has(name);
  if (DIV_OK.has(name)) return DIV_RE.test(arg);
  if (FMT_OK.has(name)) return FMT_RE.test(arg);
  return false;
}

/** The template's parts, or null when it holds a placeholder outside the set or a stray brace. Cached per string. */
function parse(tpl: string): Part[] | null {
  const hit = parsed.get(tpl);
  if (hit !== undefined) return hit;
  const parts: Part[] = [];
  const q = tpl.indexOf('?');
  let lit = '';
  let ok = true;
  for (let i = 0; i < tpl.length && ok; i++) {
    const c = tpl[i]!;
    const dollar = c === '$' && tpl[i + 1] === '{';
    if (c === '{' || dollar) {
      const open = dollar ? i + 1 : i;
      const close = tpl.indexOf('}', open);
      if (close === -1) {
        ok = false;
        break;
      }
      const body = tpl.slice(open + 1, close);
      const colon = body.indexOf(':');
      const name = colon === -1 ? body : body.slice(0, colon);
      const arg = colon === -1 ? undefined : body.slice(colon + 1);
      if (!validPart(name, arg) || body.includes('{')) {
        ok = false;
        break;
      }
      if (lit) parts.push({ lit });
      lit = '';
      const p: Part = { name, query: q !== -1 && open > q };
      if (arg !== undefined) p.arg = arg;
      parts.push(p);
      i = close;
    } else if (c === '}') {
      ok = false;
    } else {
      lit += c;
    }
  }
  if (lit) parts.push({ lit });
  const out = ok ? parts : null;
  // Templates are interned per source (at most 256), so the cache stays small; cap it anyway.
  if (parsed.size > 1024) parsed.clear();
  parsed.set(tpl, out);
  return out;
}

/** True when every placeholder in `tpl` is in the supported set. */
export function validTemplate(tpl: string): boolean {
  return parse(tpl) !== null;
}


function fmt(w: WallClock, f: string): string {
  let out = '';
  for (const ch of f) {
    out += ch === 'Y' ? pad(w.Y, 4) : ch === 'm' ? pad(w.m) : ch === 'd' ? pad(w.d) : ch === 'H' ? pad(w.H)
      : ch === 'M' ? pad(w.M) : ch === 'S' ? pad(w.S) : ch;
  }
  return out;
}

/**
 * Renders `tpl` for programme times `t` in `zone`. Values are percent-encoded only in the query (after `?`).
 * Throws on an invalid template (callers validate at parse time).
 */
export function renderTemplate(tpl: string, t: TemplateTimes, zone: CatchupZone): string {
  const parts = parse(tpl);
  if (!parts) throw new Error('Unsupported catch-up template');
  const sec = (ms: number) => Math.floor(ms / 1000);
  let startWall: WallClock | undefined;
  let endWall: WallClock | undefined;
  const sw = () => (startWall ??= wallClock(t.start, zone));
  const ew = () => (endWall ??= wallClock(t.stop, zone));
  let out = '';
  for (const p of parts) {
    if ('lit' in p) {
      out += p.lit;
      continue;
    }
    let v: string;
    const n = p.name;
    if (p.arg !== undefined && FMT_OK.has(n)) v = fmt(n === 'utc' || n === 'start' ? sw() : ew(), p.arg);
    else if (n === 'utc' || n === 'start') v = String(sec(t.start));
    else if (n === 'utcend' || n === 'end') v = String(sec(t.stop));
    else if (n === 'lutc' || n === 'now' || n === 'timestamp') v = String(sec(t.now));
    else if (n === 'duration' || n === 'offset') {
      const s = n === 'duration' ? sec(t.stop - t.start) : sec(t.now - t.start);
      v = String(Math.floor(s / Number(p.arg ?? 1)));
    } else v = fmt(sw(), n);
    out += p.query ? encodeURIComponent(v) : v;
  }
  return out;
}

/**
 * The smallest start step `tpl` can express: 60 000 ms when the start appears as wall-clock time without seconds
 * (the minute floor keeps any Unix form in agreement), else 1 000 ms.
 */
export function templateStepMs(tpl: string): number {
  const parts = parse(tpl);
  if (!parts) return 1000;
  let wall = false;
  let seconds = false;
  for (const p of parts) {
    if ('lit' in p) continue;
    if (WALL.has(p.name)) {
      wall = true;
      if (p.name === 'S') seconds = true;
    } else if ((p.name === 'utc' || p.name === 'start') && p.arg !== undefined) {
      wall = true;
      if (p.arg.includes('S')) seconds = true;
    }
  }
  return wall && !seconds ? 60_000 : 1000;
}
