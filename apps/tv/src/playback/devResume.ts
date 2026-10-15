/**
 * Dev builds only (spec 2026-10-15-gentle-source §3.1): after a page load, Home does not resume the last channel by
 * itself when it comes from a remote source, so hot reloads never reconnect to a real source. The local fake source
 * still resumes. Production builds (TVs) always resume.
 */
export const LOCAL_FAKE_HOST = '127.0.0.1:8899';
export const PAUSED_NOTE = 'Paused after reload: press OK to play';

export interface DevResumeGate {
  /** May Home resume the channel at `url` by itself? The first call after the page load decides. */
  allows(url: string): boolean;
  /** The user started a channel: resuming works normally again until the next page load. */
  release(): void;
  /** True while a remote source's resume is held back and nothing was started since. */
  paused(): boolean;
}

/** The URL's host is the local fake source (only parsed, never logged: stream URLs carry credentials). */
export function isLocalFake(url: string): boolean {
  try {
    return new URL(url).host === LOCAL_FAKE_HOST;
  } catch {
    return false;
  }
}

export function createDevResumeGate(dev: boolean): DevResumeGate {
  let held: boolean | undefined; // undefined: no resume decided since the page load
  return {
    allows(url) {
      if (!dev) return true;
      if (held === undefined) held = !isLocalFake(url);
      return !held;
    },
    release() {
      held = false;
    },
    paused: () => held === true,
  };
}

/** The app's gate. It lives as long as the page, so a reload, and only a reload, starts it afresh. */
export const devResume = createDevResumeGate(import.meta.env.DEV);
