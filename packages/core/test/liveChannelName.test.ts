import { describe, expect, test } from 'vitest';
import { parseChannelName } from '../src/live/channelName.ts';

describe('parseChannelName', () => {
  test('prefix, quality and spare tags', () => {
    expect(parseChannelName('SE: Channel One HD')).toEqual({ country: 'SE', display: 'Channel One', base: 'channel one', quality: 2, backup: false });
    expect(parseChannelName('Channel One FHD')).toEqual({ display: 'Channel One', base: 'channel one', quality: 1, backup: false });
    expect(parseChannelName('Channel One (backup)')).toMatchObject({ display: 'Channel One', base: 'channel one', quality: 4, backup: true });
    expect(parseChannelName('Channel One 4K')).toMatchObject({ base: 'channel one', quality: 0 });
    expect(parseChannelName('Channel One (backup 2) [HD]')).toMatchObject({ base: 'channel one', backup: true, quality: 2 });
    expect(parseChannelName('Channel One ALT')).toMatchObject({ base: 'channel one', backup: true });
  });
  test('VIP is part of the name, not a spare feed', () => {
    expect(parseChannelName('Channel One VIP')).toMatchObject({ display: 'Channel One VIP', base: 'channel one vip', backup: false });
    expect(parseChannelName('Channel One [VIP] HD')).toMatchObject({ base: 'channel one vip', backup: false, quality: 2 });
  });
  test('country aliases', () => {
    expect(parseChannelName('GB: Channel One').country).toBe('UK');
    expect(parseChannelName('USA | Channel One').country).toBe('US');
  });
  test('spare tags only at the end', () => {
    expect(parseChannelName('Alt Rock TV')).toMatchObject({ display: 'Alt Rock TV', backup: false });
    expect(parseChannelName('Backup')).toMatchObject({ display: 'Backup', backup: false });
  });
  test('timeshift and feeds stay apart', () => {
    expect(parseChannelName('Channel One +1').base).toBe('channel one plus1');
    expect(parseChannelName('Channel One 1').base).toBe('channel one 1');
    expect(parseChannelName('Channel One East').base).toBe('channel one east');
    expect(parseChannelName('Channel One +1').display).toBe('Channel One +1');
  });
  test('superscript quality', () => {
    expect(parseChannelName('Channel One ᴴᴰ')).toMatchObject({ display: 'Channel One', quality: 2 });
  });
});

describe('parseChannelName: long names', () => {
  test('a long run of separators before the end is linear, not quadratic', () => {
    const t = performance.now();
    expect(parseChannelName('News ' + '- '.repeat(40000) + 'x').backup).toBe(false);
    expect(parseChannelName('News ' + '- '.repeat(40000) + 'backup')).toMatchObject({ display: 'News', backup: true });
    expect(performance.now() - t).toBeLessThan(200);
  });
  test('spare tags after separators, brackets and spaces as before', () => {
    expect(parseChannelName('Channel One - ( backup 2 )')).toMatchObject({ display: 'Channel One', backup: true });
    expect(parseChannelName('Channel One | ALT | dead')).toMatchObject({ display: 'Channel One', backup: true });
    expect(parseChannelName('Channel One,bkp1')).toMatchObject({ display: 'Channel One', backup: true });
    expect(parseChannelName('Channel One [reserve]')).toMatchObject({ display: 'Channel One', backup: true });
  });
});
