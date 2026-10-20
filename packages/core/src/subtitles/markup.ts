/**
 * Subtitle markup to the plain text the app draws. Every subtitle path goes through here: AVPlay's
 * `onsubtitlechange` (raw SAMI/SRT/VTT markup, `<br>` included), HTML5 text-track cues, and loaded files.
 * Styling is dropped (the app's outlined text has no italics or colour).
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

// <br>, <BR/>, <br />, </br>, <br class=x>, and an unclosed <br (cut off, or followed by a space or line end:
// text after the space stays, only name=value pairs count as attributes).
const BREAK = /<\s*\/?\s*br\b(?:\s+[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s<>]+))*\s*\/?\s*>?/gi;
// A closed tag: <i>, </font>, <c.yellow>, <v Anna>, <SYNC Start=1>; also WebVTT timestamps <00:01.500>.
// A tag may span lines; '<' followed by a space or digit-and-text ("a < b", "3<4") is not a tag.
const TAG = /<\/?[a-z][^<>]*>|<\d+(?::\d+)+(?:\.\d+)?>/gi;
// An unclosed styling tag left at a line end (cut off by the source).
const OPEN_TAG = /<\/?\s*(?:i|b|u|s|font|span|c|v|p|sync|ruby|rt|lang)\b[^<>\n]*(?=\n|$)/gi;
// ASS/SSA override blocks: {\an8}, {\i1}, {\pos(1,2)\c&H00FFFF&}; an unclosed one runs to the line end.
const OVERRIDE = /\{\\[^}\n]*\}?/g;

function entity(all: string, name: string): string {
  if (name[0] === '#') {
    const hex = name[1] === 'x' || name[1] === 'X';
    const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }
  const v = ENTITIES[name.toLowerCase()];
  return v === undefined ? all : v;
}

/** Cue text to display: line breaks as '\n', tags and overrides removed, entities decoded, blank lines dropped. */
export function subtitleText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(BREAK, '\n')
    .replace(OVERRIDE, '')
    .replace(TAG, '')
    .replace(OPEN_TAG, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, entity)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
