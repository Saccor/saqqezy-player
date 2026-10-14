import type { LivePreset } from './types.ts';

export interface PresetNumbers {
  /** HLS target = max(hlsMultiple × target duration, hlsFloorS). */
  hlsMultiple: number;
  hlsFloorS: number;
  /** Raw TS (no segment duration): seconds of buffer to keep. */
  tsTargetS: number;
  /** Added to the target after each stall. */
  stallIncrementS: number;
  /** Cap on the learned raise when the segment duration is unknown (else one segment). */
  maxRaiseDefaultS: number;
  /** Seek back to live when more than max(seekFloorS, target) beyond the target. */
  seekFloorS: number;
  /** Reopen the stream when more than this many seconds beyond the target. */
  reopenAboveS: number;
}

export const PRESETS: Record<LivePreset, PresetNumbers> = {
  low: { hlsMultiple: 1.5, hlsFloorS: 4, tsTargetS: 1.5, stallIncrementS: 0.5, maxRaiseDefaultS: 2, seekFloorS: 2, reopenAboveS: 15 },
  balanced: { hlsMultiple: 2, hlsFloorS: 6, tsTargetS: 3, stallIncrementS: 0.75, maxRaiseDefaultS: 3, seekFloorS: 4, reopenAboveS: 20 },
  stable: { hlsMultiple: 3, hlsFloorS: 10, tsTargetS: 6, stallIncrementS: 1, maxRaiseDefaultS: 4, seekFloorS: 8, reopenAboveS: 30 },
};

const known = (td: number | undefined): td is number => td !== undefined && Number.isFinite(td) && td > 0;

/** Target seconds behind live (HLS, `td` = target duration) or seconds of buffer (raw TS, no `td`). */
export function presetTargetS(p: LivePreset, td?: number): number {
  const n = PRESETS[p];
  return known(td) ? Math.max(n.hlsMultiple * td, n.hlsFloorS) : n.tsTargetS;
}

export function maxRaiseS(p: LivePreset, td?: number): number {
  return known(td) ? td : PRESETS[p].maxRaiseDefaultS;
}

export function seekThresholdS(p: LivePreset, targetS: number): number {
  return Math.max(PRESETS[p].seekFloorS, targetS);
}

export function reopenThresholdS(p: LivePreset): number {
  return PRESETS[p].reopenAboveS;
}
