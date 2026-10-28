/** `n` as a decimal of at least `width` digits, zero-padded: `zeroPad(7)` is `07`, `zeroPad(26, 4)` is `0026`. */
export const zeroPad = (n: number, width = 2): string => String(n).padStart(width, '0');
