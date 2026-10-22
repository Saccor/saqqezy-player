import { describe, expect, test } from 'vitest';
import { TV_EPG_BATCH } from '@iptv/core';
import { guideBatchFor } from './workerOptions.ts';

describe('guideBatchFor', () => {
  test('TVs write the guide in batches of 1,000; desktop and the browser keep the default', () => {
    expect(TV_EPG_BATCH).toBe(1000);
    for (const p of ['tizen', 'webos', 'androidtv'] as const) expect(guideBatchFor(p)).toBe(TV_EPG_BATCH);
    for (const p of ['browser', 'desktop'] as const) expect(guideBatchFor(p)).toBeUndefined();
  });
});
