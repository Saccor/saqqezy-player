import type { LedgerEvent } from '@iptv/player';

/**
 * Sources that cut the oldest stream instead of refusing the newest (spec 2026-10-20-multiview §5.5). Fed with the
 * connection ledger's events; pure. A window that played steadily (10 s or more) and drops within 8 s of another
 * window opening on the same source and host was displaced: the app then stops the newest window, so the two never
 * knock each other out in turn. Two windows that keep failing alternately (3 drops in 60 s) are a ping-pong: the one
 * that began last stops.
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

interface Begin { tile: number; at: number; concurrentBefore: number }

export function createDisplacementDetector(opts: DisplacementOptions = {}): { feed(e: LedgerEvent): DisplacementVerdict | undefined } {
  const steadyMs = opts.steadyMs ?? 10_000;
  const windowMs = opts.windowMs ?? 8_000;
  const pingPongMs = opts.pingPongMs ?? 60_000;
  const pingPongDrops = opts.pingPongDrops ?? 3;
  const begins = new Map<string, Begin[]>();
  const active = new Map<string, Set<number>>();
  const drops = new Map<string, Array<{ tile: number; at: number }>>();
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
      if (e.k === 'begin') {
        open.delete(e.tile);
        const b = list(begins, where);
        b.push({ tile: e.tile, at: e.at, concurrentBefore: open.size });
        // Only the recent ones matter.
        while (b.length > 16) b.shift();
        open.add(e.tile);
        return undefined;
      }
      if (e.k !== 'dropped') return undefined;
      open.delete(e.tile);
      if (e.playedMs >= steadyMs) {
        const by = [...(begins.get(where) ?? [])].reverse()
          .find((b) => b.tile !== e.tile && e.at - b.at >= 0 && e.at - b.at < windowMs);
        if (by) {
          return { k: 'displaced', key: e.key, host: e.host, victim: e.tile, byTile: by.tile, afterMs: e.at - by.at, concurrentBefore: by.concurrentBefore };
        }
      }
      const d = list(drops, where);
      d.push({ tile: e.tile, at: e.at });
      while (d.length && e.at - d[0]!.at > pingPongMs) d.shift();
      // The latest run of drops that alternate between two windows.
      const run = [d.at(-1)!];
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
