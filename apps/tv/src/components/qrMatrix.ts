import qrcode from 'qrcode-generator';

/**
 * QR encoding for the pairing page, kept apart from `screens/pairingLogic.ts` so that Live TV (which reads the phone
 * badge from pairing logic at start) does not pull the QR library into the start bundle (spec 2026-10-26 §0.3).
 */

/** A QR symbol: `size` x `size` modules, row-major, true = dark. No quiet zone. */
export interface QrMatrix { size: number; dark: boolean[] }

/** Encodes text (byte mode, smallest version that fits) at error-correction level M. */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const dark: boolean[] = new Array<boolean>(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) dark[r * size + c] = qr.isDark(r, c);
  }
  return { size, dark };
}

/** Quiet zone around the symbol, in modules (the QR spec asks for 4). */
export const QR_QUIET_MODULES = 4;
