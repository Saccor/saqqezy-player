import type { AspectMode, Rect } from '@iptv/player';

export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;
export const FULLSCREEN: Rect = { x: 0, y: 0, w: DESIGN_WIDTH, h: DESIGN_HEIGHT };

/** Design-space (1920x1080) to CSS pixel factor; the Lightning canvas uses the same factor. */
export function designScale(win: { innerWidth: number; innerHeight: number } = window): number {
  return Math.min(win.innerWidth / DESIGN_WIDTH, win.innerHeight / DESIGN_HEIGHT);
}

/** Maps a design-space rect to CSS pixels. */
function toCss(rect: Rect, scale: number): Rect {
  return { x: rect.x * scale, y: rect.y * scale, w: rect.w * scale, h: rect.h * scale };
}

const FORCED_RATIO: Partial<Record<AspectMode, number>> = { '16:9': 16 / 9, '4:3': 4 / 3 };
const OBJECT_FIT: Record<AspectMode, string> = {
  auto: 'contain', stretch: 'fill', zoom: 'cover', '16:9': 'fill', '4:3': 'fill',
};

export interface VideoLayer {
  readonly video: HTMLVideoElement;
  setRect(rect: Rect | 'fullscreen'): void;
  setAspect(mode: AspectMode): void;
  /** Re-applies the layout, e.g. after a window resize. */
  relayout(): void;
  destroy(): void;
}

/**
 * A video root for multiview slot `n` (1..5), right after `#video-layer` and styled like it (`.video-slot` in
 * index.html): `createVideoLayer` then owns it as it owns the main root. Slot 0 keeps `#video-layer` itself.
 */
export function createSlotRoot(root: HTMLElement, n: number): HTMLElement {
  const el = root.ownerDocument.createElement('div');
  el.className = 'video-slot';
  el.dataset.slot = String(n);
  root.after(el);
  return el;
}

/**
 * Owns the `<video>` beneath the transparent Lightning canvas:
 * `#video-layer` (positioned at the rect) > `.video-box` (forced-aspect box) > `<video>`.
 */
export function createVideoLayer(root: HTMLElement): VideoLayer {
  const box = document.createElement('div');
  box.className = 'video-box';
  const video = document.createElement('video');
  video.playsInline = true;
  video.autoplay = false;
  video.preload = 'auto';
  box.appendChild(video);
  root.appendChild(box);

  let rect: Rect = FULLSCREEN;
  let aspect: AspectMode = 'auto';

  const apply = () => {
    const css = toCss(rect, designScale());
    Object.assign(root.style, {
      left: `${css.x}px`, top: `${css.y}px`, width: `${css.w}px`, height: `${css.h}px`,
    });
    const ratio = FORCED_RATIO[aspect];
    let bw = css.w;
    let bh = css.h;
    if (ratio !== undefined) {
      // Contain a fixed-ratio box inside the rect; the picture is stretched to that ratio.
      if (css.w / css.h > ratio) bw = css.h * ratio;
      else bh = css.w / ratio;
    }
    Object.assign(box.style, {
      left: `${(css.w - bw) / 2}px`, top: `${(css.h - bh) / 2}px`, width: `${bw}px`, height: `${bh}px`,
    });
    video.style.objectFit = OBJECT_FIT[aspect];
  };
  apply();

  return {
    video,
    setRect(r) {
      rect = r === 'fullscreen' ? FULLSCREEN : { ...r };
      apply();
    },
    setAspect(mode) {
      aspect = mode;
      apply();
    },
    relayout: apply,
    destroy() {
      box.remove();
    },
  };
}
