import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '@iptv/player';
import { CUE_LANGUAGE_MAX_CHARS, cueLanguageCollector } from './cueLanguage.ts';

const track = (id: string, label = `Subtitles ${id}`, language?: string): TrackInfo => {
  const t: TrackInfo = { id, label, active: true };
  if (language) t.language = language;
  return t;
};

const SWEDISH = ['Jag vet inte vad du pratar om.', 'Vi måste gå nu.', 'Det är inte säkert här.', 'Kom igen, vi har inte tid.'];

describe('cueLanguageCollector', () => {
  it('detects the active track\'s language from its first cues, once', () => {
    const found: [string, string][] = [];
    const c = cueLanguageCollector((id, lang) => found.push([id, lang]));
    const active = track('2');
    let reads = 0;
    const get = () => { reads++; return active; };
    for (const line of SWEDISH) c.add(line, get);
    expect(found).toEqual([['2', 'sv']]);
    const before = reads;
    c.add('Mer text.', get);
    c.add('Mer text.', get);
    expect(found).toHaveLength(1);
    expect(reads).toBe(before + 2); // still asks which track is active (it may change), but detects nothing more
  });

  it('skips tracks that already name their language, and empty cues', () => {
    const found: string[] = [];
    const c = cueLanguageCollector((id) => found.push(id));
    for (const line of SWEDISH) c.add(line, () => track('1', 'English', 'en'));
    for (const line of SWEDISH) c.add(line, () => track('3', 'Svenska'));
    c.add('', () => track('4'));
    c.add(null, () => track('4'));
    expect(found).toEqual([]);
  });

  it('keeps a separate buffer per track (the user may switch)', () => {
    const found: [string, string][] = [];
    const c = cueLanguageCollector((id, lang) => found.push([id, lang]));
    c.add(SWEDISH[0]!, () => track('1'));
    c.add('I do not know what you are talking about.', () => track('2'));
    c.add(SWEDISH[1]!, () => track('1'));
    c.add('We have to go now, it is not safe here.', () => track('2'));
    c.add(SWEDISH[2]!, () => track('1'));
    expect(found).toContainEqual(['2', 'en']);
    expect(found).toContainEqual(['1', 'sv']);
  });

  it('gives up on a track after enough text without a clear language', () => {
    const found: string[] = [];
    const c = cueLanguageCollector((id) => found.push(id));
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. ';
    for (let i = 0; i * filler.length < CUE_LANGUAGE_MAX_CHARS + filler.length; i++) c.add(filler, () => track('5'));
    // Past the cap the buffer is dropped: even clear text no longer counts for that track.
    for (const line of SWEDISH) c.add(line, () => track('5'));
    expect(found).toEqual([]);
  });

  it('no active track: nothing', () => {
    const found: string[] = [];
    const c = cueLanguageCollector((id) => found.push(id));
    for (const line of SWEDISH) c.add(line, () => undefined);
    expect(found).toEqual([]);
  });
});
