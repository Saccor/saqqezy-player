/** "(2021)" or "[2021]" as the whole string: matched against the last six characters of a trimmed name. */
const YEAR_RE = /^[([](\d{4})[)\]]$/;
const MARKERS = [/\bS(\d{1,2})\s*E(\d{1,3})\b/i, /\b(\d{1,2})x(\d{2,3})\b/i];
const LEADING_SEPARATORS = /^[\s\-–—|:.]+/;
/** Words whose trailing `.` is part of the word (`Dr.`, `Vol.`), so edge stripping keeps it. */
const ABBREVIATION = /(?:^|[^\p{L}])(?:dr|mr|mrs|ms|st|vol|jr|sr|mt|prof)$/iu;
const TRAILING_SEPARATOR = /[\s\-–—|:.]/;

/**
 * Where the run of `[\s\-–—|:.]` at the end of `s` starts (`s.length` without one). A scan from the right: an
 * end-anchored regex backtracks quadratically on a long run that does not reach the end.
 */
function trailingRunStart(s: string): number {
  let i = s.length;
  while (i > 0 && TRAILING_SEPARATOR.test(s[i - 1]!)) i--;
  return i;
}

function clean(s: string): string {
  const lead = s.replace(LEADING_SEPARATORS, '');
  const at = trailingRunStart(lead);
  let out = lead;
  if (at < lead.length) {
    out = lead.slice(0, at);
    if (lead[at] === '.' && ABBREVIATION.test(out)) out += '.';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** "Title (2021)" → { title: "Title", year: 2021 }. Years outside 1900–2100, or nothing left of the title, keep the name. */
export function splitYear(name: string): { title: string; year?: number } {
  const end = name.trimEnd();
  const m = end.length >= 6 ? YEAR_RE.exec(end.slice(-6)) : null;
  if (!m) return { title: name.trim() };
  const year = Number(m[1]);
  const title = end.slice(0, -6).trim();
  if (year < 1900 || year > 2100 || !title) return { title: name.trim() };
  return { title, year };
}

/**
 * Finds an `SxxEyy`, `Sxx Eyy` or `NxNN` marker. `show` is the text before the marker (or after it, when the marker
 * comes first); `title` is the text after the marker, or the whole name when nothing follows it.
 */
export function parseEpisodeMarker(name: string): { show: string; season: number; episode: number; title: string } | undefined {
  for (const re of MARKERS) {
    const m = re.exec(name);
    if (!m) continue;
    const before = clean(name.slice(0, m.index));
    const after = clean(name.slice(m.index + m[0].length));
    const show = before || after;
    if (!show) return undefined;
    return { show, season: Number(m[1]), episode: Number(m[2]), title: before && after ? after : name.trim() };
  }
  return undefined;
}
