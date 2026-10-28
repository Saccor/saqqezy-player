import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audioCodecOf } from '../../src/index.ts';

const v = JSON.parse(readFileSync(new URL('./codecs.json', import.meta.url), 'utf8')) as { audio: [string, string][]; audioUnknown: string[] };
describe('audioCodecOf', () => {
  it.each(v.audio)('%s -> %s', (raw, want) => expect(audioCodecOf(raw)).toBe(want));
  it.each(v.audioUnknown)('%j -> undefined', (raw) => expect(audioCodecOf(raw)).toBeUndefined());
  it('undefined -> undefined', () => expect(audioCodecOf(undefined)).toBeUndefined());
});
