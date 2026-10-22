import type { LedgerEvent } from '@iptv/player';

/**
 * Sources that cut the oldest stream instead of refusing the newest (spec 2026-10-20-multiview §5.5, G9 decision C).
 * Fed with the connection ledger's events; pure. A window that played steadily (10 s or more) and drops within 30 s of
 * another window's first picture on the same source and host (or of its open, while it has none yet) was displaced:
 * the app then stops the newest window, so the two never knock each other out in turn. 30 s from the first picture:
 * AVPlay shows a cut only once its buffer runs dry plus its 8 s no-progress limit, and an HLS player only at its next
 * playlist reload. Two windows that keep failing alternately (3 drops in 120 s) are a ping-pong: the one that began
 * last stops. A label (the window's slot) belongs to its latest stream: events of an older stream under the
 * same label are ignored, since the windows they would name cannot be told apart. A label stopped without a drop
 * (`closed`) is no longer open.
 */
export type DisplacementVerdict =
  | { k: 'displaced'; key: string; host: string; victim: number; byTile: number; afterMs: number; concurrentBefore: number }
  | { k: 'pingPong'; key: string; host: string; stop: number };

export interface DisplacementOptions {
  steadyMs?: number;
  windowMs?: number;
  pingPongMs?: number;
  /** Alternating drops in a row that make a ping-pong. */
  pingPongDrops?: number;
}

/** `pictureAt`: the stream's first picture. */
interface Begin { tile: number; session: number; at: number; concurrentBefore: number; pictureAt?: number }

export function createDisplacementDetector(opts: DisplacementOptions = {}): { feed(e: LedgerEvent): DisplacementVerdict | undefined } {
  const steadyMs = opts.steadyMs ?? 10_000;
  const windowMs = opts.windowMs ?? 30_000;
  const pingPongMs = opts.pingPongMs ?? 120_000;
  const pingPongDrops = opts.pingPongDrops ?? 3;
  const begins = new Map<string, Begin[]>();
  const active = new Map<string, Set<number>>();
  const drops = new Map<string, Array<{ tile: number; at: number }>>();
  /** Per source and host, each label's latest session. */
  const owners = new Map<string, Map<number, number>>();
  const list = <T>(m: Map<string, T[]>, k: string): T[] => {
    let l = m.get(k);
    if (!l) m.set(k, (l = []));
    return l;
  };

  return {
    feed(e) {
      const where = `${e.key}\n${e.host}`;
      const open = active.get(where) ?? new Set<number>();
      active.set(where, open);
      let owner = owners.get(where);
      if (!owner) owners.set(where, (owner = new Map()));
      if (e.k === 'begin') {
        owner.set(e.tile, e.session);
        open.delete(e.tile);
        const b = list(begins, where);
        b.push({ tile: e.tile, session: e.session, at: e.at, concurrentBefore: open.size });
        // Only the recent ones matter.
        while (b.length > 16) b.shift();
        open.add(e.tile);
        return undefined;
      }
      // A later stream reused this label: this event is not the window's.
      if (owner.has(e.tile) && owner.get(e.tile) !== e.session) return undefined;
      if (e.k === 'playing') {
        const b = begins.get(where)?.find((x) => x.tile === e.tile && x.session === e.session);
        if (b) b.pictureAt ??= e.at;
        return undefined;
      }
      // Stopped without a drop: no longer open, so it does not count in a later window's `concurrentBefore`.
      if (e.k === 'closed') {
        open.delete(e.tile);
        return undefined;
      }
      open.delete(e.tile);
      if (e.playedMs >= steadyMs) {
        // Measured from the other window's first picture, or from its open while it has none yet.
        const from = (b: Begin) => (b.pictureAt !== undefined && b.pictureAt <= e.at ? b.pictureAt : b.at);
        const by = [...(begins.get(where) ?? [])].reverse()
          .find((b) => b.tile !== e.tile && owner.get(b.tile) === b.session && e.at - from(b) >= 0 && e.at - from(b) < windowMs);
        if (by) {
          return { k: 'displaced', key: e.key, host: e.host, victim: e.tile, byTile: by.tile, afterMs: e.at - from(by), concurrentBefore: by.concurrentBefore };
        }
      }
      const d = list(drops, where);
      d.push({ tile: e.tile, at: e.at });
      while (d.length && e.at - d[0]!.at > pingPongMs) d.shift();
      // The latest run of drops that alternate between two windows.
      const run = [d[d.length - 1]!];
      for (let i = d.length - 2; i >= 0; i--) {
        const prev = run[run.length - 1]!;
        if (d[i]!.tile === prev.tile) break;
        if (run.length >= 2 && d[i]!.tile !== run[run.length - 2]!.tile) break;
        run.push(d[i]!);
      }
      if (run.length >= pingPongDrops) {
        const pair = new Set(run.map((r) => r.tile));
        const lastBegin = (tile: number) => Math.max(...(begins.get(where) ?? []).filter((b) => b.tile === tile).map((b) => b.at), -Infinity);
        const [a, b] = [...pair] as [number, number];
        drops.set(where, []);
        return { k: 'pingPong', key: e.key, host: e.host, stop: lastBegin(a) >= lastBegin(b) ? a : b };
      }
      return undefined;
    },
  };
}

/** What the response needs from the app: whether multiview is open, and the windows' stop and one reconnect. */
export interface CutResponseDeps {
  multiviewOpen(): boolean;
  stop(slot: number): void;
  reconnect(slot: number): void;
}

/**
 * The response to a verdict, run one macrotask after it: the newest window stops; a window the source cut then gets
 * its one normal reconnect. Nothing once multiview has closed: a late verdict never stops the single view's stream.
 */
export function applyCutResponse(v: DisplacementVerdict, d: CutResponseDeps): void {
  if (!d.multiviewOpen()) return;
  d.stop(v.k === 'displaced' ? v.byTile : v.stop);
  if (v.k === 'displaced') d.reconnect(v.victim);
}
