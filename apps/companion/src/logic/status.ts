import type { LinkStatus } from '../connection/client.ts';
import { COPY } from './copy.ts';

/**
 * The top bar: the green dot and "Connected to …" only while the link is up AND the TV answers state requests
 * (`stateStatus` 'ok'). While a Retry runs ('retrying') or after the TV stopped answering it is not online.
 * `text` is the status line when not online (undefined: show "Connected to <TV>").
 */
export function linkView(
  link: LinkStatus, stateStatus: 'ok' | 'unanswered' | 'retrying',
): { online: boolean; text: string | undefined } {
  if (link === 'online' && stateStatus === 'ok') return { online: true, text: undefined };
  if (link === 'online') return { online: false, text: COPY.notAnswering };
  return { online: false, text: link === 'reconnecting' ? 'Reconnecting…' : 'Connecting…' };
}
