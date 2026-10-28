/**
 * Live TV's catch-up opener (ported from the Guide's `openCatchup`): asks the source for the programme's archive
 * stream and opens the catch-up player. The preview keeps playing until it takes over; Back from it resumes that
 * channel (VodPlay's `resumeLive`). Not unit-tested: it drives the worker and the router.
 */
import type { ChannelRow } from '@iptv/app-api';
import { api } from '../../api.ts';
import { CATCHUP_COPY } from '../../copy.ts';
import { devResume } from '../../playback/devResume.ts';
import { router } from '../../shell/router.ts';
import { showToast } from '../../shell/Toast.tsx';
import { archiveLine } from '../../playback/catchupLogic.ts';

/** `beforePush` runs right before the catch-up player opens (Live TV marks that focus must come back from memory). */
export function createCatchupOpener(alive: () => boolean, beforePush: () => void) {
  let opening = false;
  return (ch: ChannelRow, b: { start: number; stop: number }) => {
    if (opening) return;
    opening = true;
    devResume.release(); // the user started something (spec §3.1)
    api.getCatchupPlayable(ch.id, b.start).then((r) => {
      if (!alive()) return;
      if (!('kind' in r)) {
        showToast(archiveLine(r.notAvailable, ch.archiveDays, b, Date.now()) ?? CATCHUP_COPY.noArchive);
        return;
      }
      beforePush();
      router.push('vodPlay', { catchup: r });
    }, (err) => console.warn('Catch-up failed', err instanceof Error ? err.name : 'Error'))
      .finally(() => { opening = false; });
  };
}
