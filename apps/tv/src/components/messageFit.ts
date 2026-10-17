/**
 * Fitting a centred message into a fixed box (the failure text in the previews, the Player and VodPlay's card).
 * Lightning wraps text itself; this estimates the wrapped line count from the text length so the box can centre the
 * lines and give a long message (a refusal that names the account's limit) enough lines. Pure; unit-tested.
 */
export interface MessageBox {
  /** About how many characters of the box's font fit on one line of its text width (a conservative estimate). */
  charsPerLine: number;
  maxLines: number;
  /** The line pitch drawn (the Text's `lineHeight`). */
  lineH: number;
}

/**
 * The boxes that show failure text. Text widths and fonts: Home's preview 540 px and the Guide's mini window 432 px
 * at body size (26); the Player's centred box 1020 px and VodPlay's card 920 px at heading size (32), and the card
 * at body size when the heading does not fit.
 */
export const MESSAGE_BOXES = {
  preview: { charsPerLine: 38, maxLines: 4, lineH: 32 },
  guide: { charsPerLine: 30, maxLines: 4, lineH: 32 },
  player: { charsPerLine: 58, maxLines: 3, lineH: 42 },
  vodCard: { charsPerLine: 52, maxLines: 2, lineH: 40 },
  vodCardSmall: { charsPerLine: 66, maxLines: 3, lineH: 32 },
} as const satisfies Record<string, MessageBox>;

/** The estimated wrapped line count, at least 1 and at most the box's maximum. */
export function messageLines(text: string, box: MessageBox): number {
  return Math.min(box.maxLines, Math.max(1, Math.ceil(text.length / box.charsPerLine)));
}

/** Whether `text` fits the box's lines without being cut. */
export function fitsBox(text: string, box: MessageBox): boolean {
  return Math.ceil(text.length / box.charsPerLine) <= box.maxLines;
}

/** The y of the first line that centres the text's lines in a box `height` tall. */
export function messageTop(text: string, box: MessageBox, height: number): number {
  return (height - messageLines(text, box) * box.lineH) / 2;
}

/**
 * A message with a one-line hint under it (the cooldown notice): how many lines the message takes at `fontSize` in
 * `width` (about 0.55 em a character, conservative), and where the message and the hint go so the block is centred in
 * a box `height` tall and the hint always starts below the message's last line.
 */
export function stackedMessage(
  text: string, opts: { width: number; fontSize: number; maxLines: number }, height: number, hintSize: number,
): { lines: number; lineH: number; textY: number; hintY: number } {
  const box: MessageBox = {
    charsPerLine: Math.max(1, Math.floor(opts.width / (opts.fontSize * 0.55))),
    maxLines: opts.maxLines,
    lineH: Math.round(opts.fontSize * 1.25),
  };
  const lines = messageLines(text, box);
  const gap = 12;
  const hintH = Math.round(hintSize * 1.25);
  const textY = Math.max(0, Math.round((height - (lines * box.lineH + gap + hintH)) / 2));
  return { lines, lineH: box.lineH, textY, hintY: textY + lines * box.lineH + gap };
}
