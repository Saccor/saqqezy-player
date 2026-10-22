import { createSignal } from 'solid-js';
// Type-only: @iptv/core must stay out of the main-thread bundle.
import type { SourceConfig } from '@iptv/core';

/** An Xtream account's connection limit from its last login or refresh; M3U sources have none. */
export function maxConnectionsOf(src: SourceConfig | undefined): number | undefined {
  return src?.kind === 'xtream' ? src.maxConnections : undefined;
}

/**
 * The active source's connection limit, for the failure text (spec 2026-10-16-source-retry §2.8). `load` re-reads it
 * (the source changed, or a refusal may follow a refresh that learnt a new limit); only the newest read counts, and a
 * failed read keeps the last value. `of(id)` answers only for the source that was read.
 */
export function createSourceLimit(getSource: (id: string) => Promise<SourceConfig | undefined>) {
  const [limit, setLimit] = createSignal<{ id: string; max: number | undefined } | undefined>(undefined);
  let seq = 0;
  return {
    of(id: string | undefined): number | undefined {
      const l = limit();
      return l !== undefined && l.id === id ? l.max : undefined;
    },
    async load(id: string | undefined): Promise<void> {
      const mine = ++seq;
      if (id === undefined) {
        setLimit(undefined);
        return;
      }
      try {
        const src = await getSource(id);
        if (mine === seq) setLimit({ id, max: maxConnectionsOf(src) });
      } catch (err) {
        console.warn('Read source limit failed', err instanceof Error ? err.name : 'Error');
      }
    },
  };
}

/** What an Xtream account had in use at its last login or refresh (Diagnostics → Connections); M3U has none. */
export function activeConnectionsOf(src: SourceConfig | undefined): number | undefined {
  return src?.kind === 'xtream' ? src.activeConnections : undefined;
}
