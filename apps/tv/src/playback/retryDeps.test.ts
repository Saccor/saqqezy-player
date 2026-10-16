import { describe, expect, it } from 'vitest';
import { REFUSAL_STATUSES, type SourceCooldown } from '@iptv/core';
import { createRetryDeps } from './retryDeps.ts';

const WAIT: SourceCooldown = { state: 'waiting', until: 9, reason: 'refused' };

describe('createRetryDeps', () => {
  it("passes core's refusal statuses, the injected random and a status probe", () => {
    const random = () => 0.25;
    const deps = createRetryDeps(() => ({ state: 'clear' }), random);
    expect(deps.refusalStatuses).toBe(REFUSAL_STATUSES);
    expect(deps.random).toBe(random);
    expect(typeof deps.probe).toBe('function');
  });

  it("blocked: asks for the probed stream's own host key (or the source when there is no source key)", () => {
    const asked: Array<string | undefined> = [];
    const deps = createRetryDeps((key) => { asked.push(key); return key === 'src-1@a.test:8080' ? WAIT : { state: 'clear' }; });
    expect(deps.blocked('src-1', 'http://a.test:8080/live/u/p/1.ts')).toBe(true);
    expect(deps.blocked('src-1', 'http://b.test/live/u/p/1.ts')).toBe(false);
    expect(deps.blocked(undefined, 'http://a.test:8080/live/u/p/1.ts')).toBe(false);
    expect(asked).toEqual(['src-1@a.test:8080', 'src-1@b.test', undefined]);
  });
});
