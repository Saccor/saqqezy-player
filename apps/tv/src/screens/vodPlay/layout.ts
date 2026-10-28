/**
 * The VOD player's layout (1080p design space) and its back-layer ids; the screen and its parts import them from here.
 */
import { TIMELINE_H } from '../../components/Timeline.tsx';
import { BUTTON_H } from '../../components/Button.tsx';
import { COLORS, LAYOUT } from '../../shell/theme.ts';

export const TICK_MS = 250;
export const TRACKS_ID = 'vodTracks';
export const SUB_URL_ID = 'vodSubtitleLink';
export const INFO_ID = 'vodStreamInfo';
export const OPTIONS_ID = 'vodOptions';
export const SUB_ONLINE_ID = 'vodSubtitleOnline';
export const SUB_VERSIONS_ID = 'vodSubtitleVersions';

/** The controls' dark band: tall enough that the title (y 596) sits where it is still ~75% dark. */
export const BAND_H = 620;
export const BAND_Y = LAYOUT.height - BAND_H;
export const CONTENT_X = LAYOUT.safeX;
export const CONTENT_W = LAYOUT.width - LAYOUT.safeX * 2;
export const TITLE_Y = 596;
export const LABEL_Y = 654;
/** The media badges: under the episode label, else in its place. */
export const BADGES_LABEL_Y = LABEL_Y + 50;
/** The timeline's hit area; the scrub bubble (88 px) sits above it, clear of the label (ends ~690). */
export const TIMELINE_Y = 788;
export const TIMES_Y = TIMELINE_Y + TIMELINE_H + 6;
export const TIME_W = 600;
export const ACTIONS_Y = 916;
/** Control row: the transport icons (round) and the text buttons. */
export const ROUND_W = BUTTON_H;
export const BACK_W = 180;
export const TRACKS_W = 240;
/** The gear (Options): a round icon button like the transport's. */
export const OPTIONS_W = BUTTON_H;
export const NEXT_W = 280;
/** The volume control at the row's left end (desktop only: TVs keep their remote's volume). */
export const VOLUME_W = 300;
export const SUB_OUTLINE: [number, number][] = [[-2, -2], [2, -2], [-2, 2], [2, 2], [0, 3]];
export const SUB_OUTLINE_COLOR = COLORS.panel;
/** The live-edge mark on a catch-up timeline. */
export const CATCHUP_W = 4;
export const CATCHUP_H = 28;
/** The x of the live-edge mark for a seek limit on a timeline of the given duration. */
export const liveEdgeX = (limitMs: number, durMs: number | undefined): number =>
  CONTENT_X + Math.round((CONTENT_W * limitMs) / Math.max(1, durMs ?? 1)) - CATCHUP_W / 2;
export const CARD_W = 1000;
export const CARD_H = 260;
/** The card's text area, between its top margin (24) and its buttons (y 148). */
export const CARD_TEXT_H = 124;

export const errName = (err: unknown) => (err instanceof Error ? err.name : 'Error');
