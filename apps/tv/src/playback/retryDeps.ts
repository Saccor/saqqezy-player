import { REFUSAL_STATUSES, streamCooldownKey, type SourceCooldown } from '@iptv/core';
import { cooldownOf } from '../state/appState.ts';
import { createStreamProbe } from './probe.ts';

/**
 * The supervisor's source-retry dependencies (spec 2026-10-16-source-retry): the status probe, every random draw,
 * core's refusal statuses, and `blocked`, which keeps the probe away from a stream whose host (or the source) is in
 * its cooldown. `cooldownOf` answers the worse of the source's and that host key's cooldown.
 */
export function createRetryDeps(cooldown: (key: string | undefined) => SourceCooldown, random: () => number = Math.random) {
  return {
    probe: createStreamProbe(),
    random,
    refusalStatuses: REFUSAL_STATUSES,
    blocked: (sourceKey: string | undefined, url: string): boolean =>
      cooldown(sourceKey === undefined ? undefined : streamCooldownKey(sourceKey, url)).state !== 'clear',
  };
}

export const retryDeps = createRetryDeps(cooldownOf);
