import { Show, View } from '@lightningtv/solid';
import { createMemo } from 'solid-js';
import { QR_QUIET_MODULES, qrMatrix } from './qrMatrix.ts';

const LIGHT = 0xffffffff;

/**
 * Draws a QR code for `text` (level M, from `qrcode-generator`): the matrix is painted onto an offscreen canvas
 * at a whole number of pixels per module, turned into a PNG data URL and shown as a Lightning image texture
 * on a light square, with the 4-module quiet zone included. Dark on light, as scanners expect.
 *
 * `text` is a pairing secret: it is only ever turned into pixels here.
 */
export function QrCode(props: { x?: number; y?: number; size: number; text: string }) {
  const image = createMemo(() => renderQr(props.text, props.size));
  return (
    <View x={props.x ?? 0} y={props.y ?? 0} width={props.size} height={props.size} color={LIGHT} borderRadius={12}>
      <Show when={image()} keyed>{(img) => (
        <View x={img.offset} y={img.offset} width={img.px} height={img.px} src={img.src} />
      )}</Show>
    </View>
  );
}

/** The data URL plus its size in design pixels (a whole number of pixels per module), centred in `size`. */
function renderQr(text: string, size: number): { src: string; px: number; offset: number } | undefined {
  if (!text) return undefined;
  const m = qrMatrix(text);
  const modules = m.size + QR_QUIET_MODULES * 2;
  const cell = Math.max(1, Math.floor(size / modules));
  const px = cell * modules;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.dark[r * m.size + c]) ctx.fillRect((c + QR_QUIET_MODULES) * cell, (r + QR_QUIET_MODULES) * cell, cell, cell);
    }
  }
  const src = canvas.toDataURL('image/png');
  return { src, px, offset: Math.floor((size - px) / 2) };
}
