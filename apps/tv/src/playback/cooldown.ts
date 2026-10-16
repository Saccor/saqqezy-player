import type { PlayableChannel } from '@iptv/app-api';
import { api } from '../api.ts';
import { cooldown } from '../state/appState.ts';
import { playback } from './playback.ts';

/** True while the current stream's host or the active source is in its refusal cooldown (nothing is sent). */
export const cooling = (): boolean => cooldown().state !== 'clear';

/**
 * Manual Retry (Home and the Player): lets one probe reach the active source and the current stream's host. `ch`
 * becomes the held channel first (nothing opens while cooling), so exactly one stream opens: the shell resumes the
 * held channel when the worker's `cooldown` event says clear. A refused probe moves the cooldown one step up; the
 * worker announces that too.
 */
export async function retrySource(ch?: PlayableChannel): Promise<void> {
  if (ch) playback.playChannel(ch);
  try {
    await api.retrySource(playback.current()?.url);
  } catch (err) {
    console.warn('Retry failed', err instanceof Error ? err.name : 'Error');
    return;
  }
  // The clear event arrives before this answer; resuming again is a no-op once the held channel opened.
  if (!cooling()) playback.resumeHeld();
}
