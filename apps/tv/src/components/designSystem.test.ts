import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const gone = (rel: string) => expect(existsSync(join(SRC, rel)), `${rel} should be deleted`).toBe(false);
const there = (rel: string) => expect(existsSync(join(SRC, rel)), `${rel} should exist`).toBe(true);
/** A file that a later task deletes passes trivially (InfoBanner after Task 15). */
const lacks = (rel: string, re: RegExp) => {
  if (!existsSync(join(SRC, rel))) return;
  expect(readFileSync(join(SRC, rel), 'utf8'), `${rel} still has ${re}`).not.toMatch(re);
};

describe('design system 2.0 (spec 2026-10-26 §1.3): new components exist, replaced ones are deleted', () => {
  it('Badge replaces MediaBadges', () => {
    there('components/Badge.tsx');
    gone('components/MediaBadges.tsx');
    lacks('components/InfoBanner.tsx', /MediaBadges/);
    lacks('screens/VodPlay.tsx', /MediaBadges/);
  });
  it('Notice replaces StatusPill and the Toast view', () => {
    there('components/Notice.tsx');
    gone('components/StatusPill.tsx');
    lacks('shell/Toast.tsx', /export function Toast\(/);
    lacks('screens/Player.tsx', /useToastFloor/);
    lacks('screens/VodPlay.tsx', /useToastFloor/);
  });
  it('Notice replaces CooldownNotice, NumberEntry, OfflineBadge and PhoneBadge', () => {
    gone('components/CooldownNotice.tsx');
    gone('components/NumberEntry.tsx');
    lacks('App.tsx', /function OfflineBadge/);
    lacks('screens/live/LiveTv.tsx', /function PhoneBadge/);
    lacks('components/VolumeOsd.tsx', /NumberEntry/);
  });
  it('Dialog replaces ConfirmDialog', () => {
    there('components/Dialog.tsx');
    gone('shell/ConfirmDialog.tsx');
  });
});
