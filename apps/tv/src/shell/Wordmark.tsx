import { Text, View, type ElementNode } from '@lightningtv/solid';
import { createEffect, on, onCleanup } from 'solid-js';
import { COLORS, LAYOUT } from './theme.ts';

/** The theme text colour at about 85% opacity. */
const INK = (COLORS.text & 0xffffff00) + 0xd9;

/** Vertical band the wordmark occupies, at the top of the overscan-safe area. */
export const WORDMARK_Y = LAYOUT.safeY;
export const WORDMARK_H = 44;
/**
 * Horizontal zone reserved for the wordmark around the screen centre. Other top-row elements (badges, headers)
 * stay outside it; the drawn wordmark is narrower and centred inside it.
 */
export const WORDMARK_ZONE_W = 520;
export const WORDMARK_ZONE_X = (LAYOUT.width - WORDMARK_ZONE_W) / 2;

const NAME_SIZE = 34;
const SUB_SIZE = 20;
const DOT = 6;
const FADE_MS = 200;
/**
 * Bold face. The canvas text engine builds its CSS font as `${fontStyle} ${fontSize}px …` for both measuring and
 * drawing, so "bold" here selects the bold weight of the built-in sans-serif (the typed union lacks it, and
 * `fontWeight` would rename the family instead). The SDF engine would ignore it and draw the regular face.
 */
const BOLD = 'bold' as 'normal';

/**
 * "SAQQEZY · MULTIMEDIA" brand wordmark, drawn as text only, centred at the top. The shell renders it once
 * above the screen host; `visible` fades it in or out over 200 ms (it is hidden in the full-screen Player).
 */
export function Wordmark(props: { visible: boolean }) {
  let node: ElementNode | undefined;
  let fade: { stop(): unknown } | undefined;
  // Fade with an explicit animation: the `transition` prop calls `animateProp`, which renderer 3.7 lacks.
  createEffect(on(() => props.visible, (visible, prev) => {
    if (!node) return;
    fade?.stop();
    fade = undefined;
    const alpha = visible ? 1 : 0;
    if (prev === undefined) { node.alpha = alpha; return; }
    fade = node.animate({ alpha }, { duration: FADE_MS, easing: 'ease-in-out' }).start();
  }));
  onCleanup(() => fade?.stop());

  return (
    <View ref={node} x={WORDMARK_ZONE_X} y={WORDMARK_Y} width={WORDMARK_ZONE_W} height={WORDMARK_H} skipFocus
      display="flex" justifyContent="center" alignItems="center" gap={16}>
      <Text fontSize={NAME_SIZE} fontStyle={BOLD} letterSpacing={2} color={INK}>{'SAQQEZY'}</Text>
      <View width={DOT} height={DOT} borderRadius={DOT / 2} color={COLORS.focus} />
      <Text fontSize={SUB_SIZE} letterSpacing={7} color={INK}>{'MULTIMEDIA'}</Text>
    </View>
  );
}
