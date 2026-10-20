/** WCAG 2 contrast ratio of two opaque `0xRRGGBBAA` colours (alpha ignored). Pure. */
export function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(rgba: number): number {
  const rgb = Math.floor(rgba / 0x100);
  const ch = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
