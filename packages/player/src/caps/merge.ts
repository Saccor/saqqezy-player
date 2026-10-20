import type { EngineName } from '../types.ts';
import type { AudioCodec, CapsPlatform, MediaCaps, MediaCapsProbe } from './types.ts';

export interface LearnedCaps { audio: Partial<Record<AudioCodec, 'none' | 'decode'>> }
export interface LearnedStore { load(key: string): LearnedCaps | undefined; save(key: string, v: LearnedCaps): void }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tok = (v: string | undefined) => (v ?? '').replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 40);

export function learnedKey(c: { platform: CapsPlatform; engine: EngineName; model?: string; firmware?: string }): string {
  return `${c.platform}|${c.engine}|${tok(c.model)}|${tok(c.firmware)}`;
}
export function learnAudio(prev: LearnedCaps | undefined, codec: AudioCodec, v: 'none' | 'decode'): LearnedCaps {
  return { audio: { ...(prev?.audio ?? {}), [codec]: v } };
}

/** static + probe + learned; later wins, except that a static 'none' falls only to learned evidence. Spec §4.2. */
export function mergeCaps(base: MediaCaps, probe?: MediaCapsProbe, learned?: LearnedCaps): MediaCaps {
  const out = clone(base);
  if (probe) {
    for (const [k, v] of Object.entries(probe.audio ?? {})) {
      const codec = k as AudioCodec;
      if (!v || v.value === undefined) continue;
      const cur = out.audio[codec];
      if (cur?.evidence === 'static' && cur.value === 'none') continue;
      out.audio[codec] = { value: v.value, evidence: 'probe' };
    }
    if (probe.audioSink?.value) out.audioSink = { value: { ...out.audioSink.value, ...probe.audioSink.value }, evidence: 'probe' };
    if (probe.quirks) out.quirks = { ...out.quirks, ...probe.quirks };
    if (probe.device) out.device = { ...out.device, ...probe.device };
  }
  for (const [k, v] of Object.entries(learned?.audio ?? {})) {
    if (v) out.audio[k as AudioCodec] = { value: v, evidence: 'learned' };
  }
  return out;
}
