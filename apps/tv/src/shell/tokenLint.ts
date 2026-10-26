// apps/tv/src/shell/tokenLint.ts
/**
 * Token and copy lint (UI rethink spec 2026-10-26 §1.5, amending the revamp spec §1.1): counts design literals and
 * inline UI strings per source file. The test compares the counts with `tokenLint.baseline.json` and fails when a file
 * gains any, so the baseline can only shrink; phase 1 ends with it at `{}`.
 * Rewrite the baseline after removing literals: `pnpm exec tsx apps/tv/src/shell/tokenLint.ts --write`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_KINDS = ['colour', 'fontSize', 'scale', 'radius', 'border', 'lineHeight', 'alpha', 'space', 'string'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type TokenCounts = Record<TokenKind, number>;
/** The baseline file: per file, only the kinds with a count above 0. */
export type Baseline = Record<string, Partial<TokenCounts>>;

const COLOUR = /0x[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g;
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?/g;
const SCALE = /scale=\{[^}]*\b1\.\d+/g;
const FONT_SIZE_PROP = /\bfontSize:\s*\d+(?:\.\d+)?\b/g;
const SCALE_PROP = /\bscale:\s*1\.\d+/g;
const RADIUS_PROP = /\bborderRadius:\s*\d+/g;
const ALPHA_PROP = /\balpha:\s*0?\.\d+/g;
const BORDER_WIDTH = /\bborder=\{\{\s*width:\s*[1-9]/g;
/** `prop={expr}` with no nested braces. */
const exprOf = (prop: string): RegExp => new RegExp(`\\b${prop}=\\{([^{}]*)\\}`, 'g');
const FONT_SIZE = exprOf('fontSize');
const RADIUS_EXPR = exprOf('borderRadius');
const LINE_HEIGHT = exprOf('lineHeight');
const ALPHA_EXPR = exprOf('alpha');
const SPACE_EXPR = /\b(?:x|y|gap)=\{([^{}]*)\}/g;
/** Theme token objects: names inside an expression that are allowed. */
const TOKEN_OBJECTS: ReadonlySet<string> = new Set(['TYPE', 'SPACE', 'RADIUS', 'LAYOUT', 'FOCUS', 'MOTION', 'COLORS', 'ALPHA', 'LINE', 'STROKE']);
/** A SCREAMING_CASE local constant (`NAME_SIZE`, `CELL_R`): a literal one step removed. */
const CONST_IDENT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g;
const constsIn = (e: string): number => (e.match(CONST_IDENT) ?? []).filter((n) => n.length > 1 && !TOKEN_OBJECTS.has(n)).length;
const numbersIn = (e: string): number[] => (e.match(NUMBER) ?? []).map(Number);
/** Computed layout is allowed: operands of `/` and `*` (`h / 2`, `i * STEP`) and `RADIUS.pill(…)` arguments. */
const stripComputed = (e: string): string =>
  e.replace(/RADIUS\.pill\([^)]*\)/g, '').replace(/[/*]\s*\d+(?:\.\d+)?/g, '').replace(/\d+(?:\.\d+)?\s*\*/g, '');
/** The spacing scale (spec §1.1 `SPACE`) and 0. */
const SPACE_OK: ReadonlySet<number> = new Set([0, 8, 16, 24, 48]);
/** A local padding, gap, margin or inset constant set to a literal (not a time: `_MS` / `_S` names are skipped). */
const SPACE_CONST = /\bconst\s+(?![A-Z0-9_]*_(?:MS|S)\s*=)[A-Z0-9_]*(?:PAD|GAP|MARGIN|INSET)[A-Z0-9_]*\s*=\s*(\d+)\s*;/g;

/** A quoted literal on one line. */
const LITERAL = /(['"`])((?:(?!\1)[^\\\n]|\\.)*?)\1/g;
/** Props and keys whose value is drawn as text, right before the literal. */
const TEXT_KEY = /\b(?:label|title|message|hint|body|text|yes|no|detail|placeholder|heading|empty|help|toast|footer|line)\s*(?:=\{?|:)\s*$/;
const TOAST_CALL = /\bshowToast\(\s*$/;
/** `<Text …>words</Text>` with bare JSX text. */
const JSX_TEXT = /<Text\b[^>]*>([^<{}]*[A-Za-z][^<{}]*)<\/Text>/g;
/** Lines that hold no UI copy: logs, thrown errors, imports. */
const NOT_UI_LINE = /console\.|new Error\(|throw |^\s*import |postMessage\(|fontFamily|querySelector|addEventListener/;
/** A sentence-like literal: starts upper case, has a lower-case word and a space (template holes count as words). */
const isSentence = (s: string): boolean => {
  const t = s.replace(/\$\{[^}]*\}/g, 'x');
  return /^[A-Z‹›▲▼✓]/.test(t) && /[a-z]{2}/.test(t) && /\s/.test(t);
};
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function countStrings(text: string): number {
  let n = 0;
  for (const line of stripComments(text).split('\n')) {
    if (NOT_UI_LINE.test(line)) continue;
    for (const m of line.matchAll(LITERAL)) {
      const s = m[2]!;
      if (!/[A-Za-z]/.test(s)) continue;
      const before = line.slice(0, m.index);
      if (isSentence(s) || TEXT_KEY.test(before) || TOAST_CALL.test(before) || /<Text\b[^>]*>\{\s*$/.test(before)) n++;
    }
    n += line.match(JSX_TEXT)?.length ?? 0;
  }
  return n;
}

const sum = (text: string, re: RegExp, f: (m: RegExpMatchArray) => number): number =>
  [...text.matchAll(re)].reduce((n, m) => n + f(m), 0);

export function countTokens(text: string): TokenCounts {
  return {
    colour: text.match(COLOUR)?.length ?? 0,
    fontSize: sum(text, FONT_SIZE, (m) => numbersIn(m[1]!).length + constsIn(m[1]!)) + (text.match(FONT_SIZE_PROP)?.length ?? 0),
    scale: (text.match(SCALE)?.length ?? 0) + (text.match(SCALE_PROP)?.length ?? 0),
    radius: sum(text, RADIUS_EXPR, (m) => {
      const e = stripComputed(m[1]!);
      return numbersIn(e).length + constsIn(e);
    }) + (text.match(RADIUS_PROP)?.length ?? 0),
    border: text.match(BORDER_WIDTH)?.length ?? 0,
    lineHeight: sum(text, LINE_HEIGHT, (m) => numbersIn(m[1]!).length + constsIn(m[1]!)),
    alpha: sum(text, ALPHA_EXPR, (m) => numbersIn(m[1]!).filter((v) => v !== 0 && v !== 1).length) + (text.match(ALPHA_PROP)?.length ?? 0),
    space: sum(text, SPACE_EXPR, (m) => numbersIn(stripComputed(m[1]!)).filter((v) => !SPACE_OK.has(v)).length)
      + sum(text, SPACE_CONST, (m) => (SPACE_OK.has(Number(m[1])) ? 0 : 1)),
    string: countStrings(text),
  };
}

/**
 * Files where literals belong, or that are not UI. components/QrCode.tsx: scanners need pure white and black modules.
 * shell/DebugOverlay.tsx: the developer HUD (Info x3), English diagnostics. copy.ts and copy/: where strings belong.
 */
const SKIP_FILES: ReadonlySet<string> = new Set([
  'shell/theme.ts', 'shell/tokenLint.ts', 'shell/contrast.ts', 'components/QrCode.tsx', 'shell/DebugOverlay.tsx', 'copy.ts',
]);
const SKIP_DIRS: ReadonlySet<string> = new Set(['dev', 'copy']);
/** video/: engine messages for the playback log; the UI shows them only through failureText. */
const STRING_SKIP_DIRS: ReadonlySet<string> = new Set(['video']);

export function scanTokens(root: string): Baseline {
  const out: Baseline = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p).replace(/\\/g, '/');
      if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(rel)) walk(p); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || SKIP_FILES.has(rel)) continue;
      const c = countTokens(readFileSync(p, 'utf8'));
      if (STRING_SKIP_DIRS.has(rel.split('/')[0]!)) c.string = 0;
      const nonZero = Object.fromEntries(TOKEN_KINDS.filter((k) => c[k] > 0).map((k) => [k, c[k]]));
      if (Object.keys(nonZero).length > 0) out[rel] = nonZero;
    }
  };
  walk(root);
  return out;
}

if (process.argv.includes('--write')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const counts = scanTokens(join(here, '..'));
  const sorted = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
  writeFileSync(join(here, 'tokenLint.baseline.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`tokenLint: baseline written for ${Object.keys(sorted).length} files`);
}
