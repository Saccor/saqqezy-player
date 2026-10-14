import { RequestError } from '../connection/pending.ts';
import type { CompanionClient } from '../connection/client.ts';
import { COPY, resultErrorCopy } from '../logic/copy.ts';
import { clearProgress, currentClient } from './store.ts';

/** Source work on the TV (loading a playlist, a guide) can take minutes; progress shows meanwhile. */
export const SOURCE_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** "Loading channels… 1,234" from the TV's progress messages. */
export function progressText(p: { phase: 'playlist' | 'epg'; count: number }): string {
  const n = p.count.toLocaleString('en-US');
  return p.phase === 'playlist' ? `Loading channels… ${n}` : `Loading TV guide… ${n} programmes`;
}

type Request = Parameters<CompanionClient['request']>[0];

/** Runs one request and turns any failure into copy (undefined on success). Then refreshes the state. */
export async function runRequest(msg: Request): Promise<string | undefined> {
  const c = currentClient();
  if (!c) return COPY.genericError;
  try {
    const r = await c.request(msg, msg.t === 'deleteSource' ? undefined : SOURCE_REQUEST_TIMEOUT_MS);
    if (r.ok) return undefined;
    return resultErrorCopy(r.error);
  } catch (e) {
    if (e instanceof RequestError && e.reason === 'timeout') return COPY.timeout;
    if (e instanceof Error && e.name === 'QueueFullError') return COPY.busy;
    return COPY.genericError;
  } finally {
    clearProgress();
    // The TV does not push source changes: ask for the state again (cheap when nothing changed).
    currentClient()?.getState();
  }
}
