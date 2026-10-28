/** InfoBlock and KeyValuePanel layout (spec 2026-10-26 §1.3). Pure: no Solid, no Lightning. */
import { LAYOUT, LINE, SPACE, TYPE } from '../shell/theme.ts';

/** The browse info strip's box (was InfoStrip's STRIP_*): rows start below it. */
export const INFO_STRIP = { x: LAYOUT.contentX, y: LAYOUT.safeY, w: 940, h: 176 } as const;
export const INFO_PROGRESS_W = 160;
export const KV_LINE_H = LINE.meta;
export const KV_LABEL_W = 180;

export interface InfoBlockShape { overline: boolean; titleSize: 'title' | 'hero'; metaLine: boolean; descriptionLines: number }

export function infoBlockLayout(s: InfoBlockShape): { overlineY: number; titleY: number; metaY: number; descriptionY: number; height: number } {
  const titleY = s.overline ? LINE.meta + SPACE.s : 0;
  const titleH = s.titleSize === 'hero' ? TYPE.hero + SPACE.s : LINE.title;
  const metaY = titleY + titleH + SPACE.s;
  const descriptionY = s.metaLine ? metaY + LINE.meta + SPACE.s : metaY;
  const height = s.descriptionLines > 0 ? descriptionY + s.descriptionLines * LINE.body : s.metaLine ? metaY + LINE.meta : titleY + titleH;
  return { overlineY: 0, titleY, metaY, descriptionY, height };
}

export function metaLineLayout(metaW: number, hasProgress: boolean): { trackX: number; trailingX: number } {
  const trackX = metaW + SPACE.m;
  return { trackX, trailingX: hasProgress ? trackX + INFO_PROGRESS_W + SPACE.m : trackX };
}

/** The overline's width when badges share its line (a long channel name never runs under them). */
export function overlineWidth(width: number, badgesW: number): number {
  return badgesW > 0 ? Math.max(0, width - badgesW - SPACE.m) : width;
}

export function keyValueHeight(n: number, hasTitle: boolean, framed: boolean): number {
  return (framed ? SPACE.l * 2 : 0) + (hasTitle ? LINE.body + SPACE.m : 0) + n * KV_LINE_H;
}
