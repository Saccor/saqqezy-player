/**
 * The video's frame rate where the engine does not report it: measured from presented frames (the browser's
 * video frame callback) or read from the TV player's track details. Pure helpers, unit-tested.
 */

/** The common rates a measured or reported rate is snapped to. */
export const COMMON_FPS: readonly number[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
/** A rate within 1% of a common one is that one. */
const SNAP_TOLERANCE = 0.01;

/** One video frame callback: the frame's media time (s) and how many frames had been presented. */
export interface FrameSample { mediaTime: number; presentedFrames: number }

/** The common rate within 1% of `fps`; undefined when none is. */
export function snapFps(fps: number | undefined): number | undefined {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) return undefined;
  let best: number | undefined;
  for (const c of COMMON_FPS) if (Math.abs(fps - c) / c <= SNAP_TOLERANCE && (best === undefined || Math.abs(fps - c) < Math.abs(fps - best))) best = c;
  return best;
}

/** The median of the values; undefined for none. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** The fewest single-frame steps a measurement needs. */
const MIN_STEPS = 5;

/**
 * The frame rate from consecutive frame callbacks: the median media-time step over the steps where exactly one frame
 * was presented (a dropped frame or a seek is left out), snapped to a common rate. Undefined when unsure.
 */
export function fpsFromSamples(samples: readonly FrameSample[]): number | undefined {
  const steps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b || b.presentedFrames - a.presentedFrames !== 1) continue;
    const dt = b.mediaTime - a.mediaTime;
    if (dt > 0 && Number.isFinite(dt)) steps.push(dt);
  }
  if (steps.length < MIN_STEPS) return undefined;
  const dt = median(steps);
  return dt ? snapFps(1 / dt) : undefined;
}

/** Plausible frame rates a track detail may give. */
const FPS_MIN = 1;
const FPS_MAX = 240;

/** "25", 25, "23.976", "24000/1001", or thousandths ("23976"); undefined when none of these. */
function parseRate(v: unknown): number | undefined {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const frac = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
    n = frac ? Number(frac[1]) / Number(frac[2]) : Number(v.trim());
  } else return undefined;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Thousandths ("23976") only when that is a standard rate: any other large number is no frame rate.
  if (n > FPS_MAX) return snapFps(n / 1000);
  if (n < FPS_MIN) return undefined;
  return snapFps(n) ?? n;
}

/** Keys a track's details may name its frame rate with ("fps", "FrameRate", "framerate", "frame_rate"). */
const FPS_KEY = /^(fps|frame_?rate|frames_?per_?second)$/i;

/** The frame rate in a TV player track's details (its parsed `extra_info`), when it names one. */
export function fpsFromTrackExtra(extra: Record<string, unknown>): number | undefined {
  for (const [k, v] of Object.entries(extra)) {
    if (!FPS_KEY.test(k)) continue;
    const fps = parseRate(v);
    if (fps !== undefined) return fps;
  }
  return undefined;
}
