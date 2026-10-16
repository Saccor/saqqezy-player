const YEAR_RE = /\s*[([](\d{4})[)\]]\s*$/;
const MARKERS = [/\bS(\d{1,2})\s*E(\d{1,3})\b/i, /\b(\d{1,2})x(\d{2,3})\b/i];
const LEADING_SEPARATORS = /^[\s\-–—|:.]+/;
const TRAILING_SEPARATORS = /[\s\-–—|:.]+$/;
/** Words whose trailing `.` is part of the word (`Dr.`, `Vol.`), so edge stripping keeps it. */
const ABBREVIATION = /(?:^|[^\p{L}])(?:dr|mr|mrs|ms|st|vol|jr|sr|mt|prof)$/iu;

function clean(s: string): string {
  const lead = s.replace(LEADING_SEPARATORS, '');
  const run = TRAILING_SEPARATORS.exec(lead);
  let out = lead;
  if (run) {
    out = lead.slice(0, run.index);
    if (run[0].startsWith('.') && ABBREVIATION.test(out)) out += '.';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** "Title (2021)" → { title: "Title", year: 2021 }. Years outside 1900–2100, or nothing left of the title, keep the name. */
export function splitYear(name: string): { title: string; year?: number } {
  const m = YEAR_RE.exec(name);
  if (!m) return { title: name.trim() };
  const year = Number(m[1]);
  const title = name.slice(0, m.index).trim();
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
