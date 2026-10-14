/**
 * The colour tokens of `styles.css`, mirrored here so their contrast can be unit-tested (tokens.test.ts checks
 * that the CSS and this file agree). Change both together.
 */
export interface ThemeTokens {
  bg: string;
  surface: string;
  'surface-2': string;
  border: string;
  'input-border': string;
  text: string;
  muted: string;
  focus: string;
  primary: string;
  'on-primary': string;
  error: string;
  'error-bg': string;
  danger: string;
  'on-danger': string;
  ok: string;
  warn: string;
}

export const DARK: ThemeTokens = {
  bg: '#0b0d12',
  surface: '#151a24',
  'surface-2': '#1d2432',
  border: '#2a3242',
  'input-border': '#6b7488',
  text: '#e8eaf0',
  muted: '#9aa1b2',
  focus: '#4f8cff',
  primary: '#2563eb',
  'on-primary': '#ffffff',
  error: '#ff8a80',
  'error-bg': '#3a1c1c',
  danger: '#c8372d',
  'on-danger': '#ffffff',
  ok: '#4cc38a',
  warn: '#f0b429',
};

export const LIGHT: ThemeTokens = {
  bg: '#f5f6f9',
  surface: '#ffffff',
  'surface-2': '#eef0f5',
  border: '#d4d8e1',
  'input-border': '#7a8090',
  text: '#12151c',
  muted: '#535b6c',
  focus: '#1f5fd6',
  primary: '#1f5fd6',
  'on-primary': '#ffffff',
  error: '#b3261e',
  'error-bg': '#fde8e6',
  danger: '#b3261e',
  'on-danger': '#ffffff',
  ok: '#1b8a54',
  warn: '#a86b00',
};

type Key = keyof ThemeTokens;

/**
 * WCAG AA pairs the UI relies on: [foreground, background, minimum ratio]. Text needs 4.5:1; input borders and
 * the focus ring (non-text UI) need 3:1 against what is around them.
 */
export const CONTRAST_PAIRS: readonly [Key, Key, number][] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surface-2', 4.5],
  ['text', 'error-bg', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface-2', 4.5],
  ['on-primary', 'primary', 4.5], // primary buttons and the Active badge
  ['on-danger', 'danger', 4.5],
  ['error', 'bg', 4.5],
  ['error', 'surface', 4.5],
  ['error', 'surface-2', 4.5], // error text on raised rows and segmented controls
  ['ok', 'surface', 3], // the connection status dot on the top bar (non-text)
  ['warn', 'surface', 3],
  ['focus', 'surface', 4.5], // the selected tab label
  ['focus', 'bg', 3],
  ['input-border', 'bg', 3], // input fill
  ['input-border', 'surface', 3], // the card around it
  ['input-border', 'surface-2', 3],
];

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
