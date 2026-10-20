export const GROUPS = ['News', 'Movies', 'Kids', 'Music'] as const;
export const TEST_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const SLOT = 30 * 60_000;

export interface FakeChannel { n: number; name: string; epgId: string; categoryId: string; group: string }

export function channels(count: number): FakeChannel[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const g = i % GROUPS.length;
    return { n, name: `Channel ${String(n).padStart(3, '0')}`, epgId: `c${n}.test`, categoryId: String(g + 1), group: GROUPS[g]! };
  });
}

/** 30-minute slots aligned to the half hour, from now-6h to now+24h. */
export function slots(now: number): { start: number; stop: number; index: number }[] {
  const first = Math.floor((now - 6 * 3600_000) / SLOT) * SLOT;
  const out = [];
  for (let t = first, i = 0; t < now + 24 * 3600_000; t += SLOT, i++) out.push({ start: t, stop: t + SLOT, index: i });
  return out;
}

const xmlDate = (ms: number) => {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};

/** Invented teams only (CLAUDE.md rule 1). `ch`: channel numbers; `at`: slots after the slot holding now; `len`: slots. */
export interface SportMatch { titles: string[]; ch: number[]; at: number; len: number; cat: string; live?: number[]; rerun?: true; sub?: string }
export const SPORT_MATCHES: readonly SportMatch[] = [
  { titles: ['LIVE: Northbridge FC v Eastport', 'Northbridge v Eastport', 'Eastport - Northbridge FC', 'Northbridge FC vs Eastport', 'Northbridge FC – Eastport'],
    ch: [1, 2, 3, 4, 5], at: 0, len: 4, cat: 'Sports', live: [1, 2] },
  { titles: ['Harbour City v Westvale United', 'Harbour City v Westvale Utd'], ch: [6, 7], at: 4, len: 4, cat: 'Football' },
  { titles: ['Rivermouth Rovers vs Kingsgate'], ch: [9], at: 2, len: 4, cat: 'Sports' },
  { titles: ['Northbridge FC v Eastport Highlights'], ch: [10], at: 6, len: 2, cat: 'Sports' },
  { titles: ['Northbridge FC v Eastport'], ch: [11], at: 8, len: 4, cat: 'Sports', rerun: true },
  { titles: ['Hollis vs Hollis'], ch: [12], at: 0, len: 4, cat: 'Film' },
  { titles: ['Lakeshore v Pinecrest'], ch: [13, 14, 15, 16], at: 10, len: 4, cat: 'Sports', sub: 'Test Cup: Round 3' },
  { titles: ['Final: A. Marlow - J. Okafor'], ch: [17, 18], at: 12, len: 6, cat: 'Tennis' },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** `history`: extra programmes before the usual 6 h for a channel (catch-up channels), given the XMLTV date format. */
export function* xmltv(
  chs: FakeChannel[], now: number, sports = false, history?: (c: FakeChannel, xmlDate: (ms: number) => string) => string,
): Generator<string> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="fake-xtream">\n';
  for (const c of chs) yield `<channel id="${c.epgId}"><display-name>${c.name}</display-name></channel>\n`;
  const s = slots(now);
  const nowSlot = s.findIndex((x) => x.start <= now && now < x.stop);
  for (const c of chs) {
    let buf = '';
    for (let i = 0; i < s.length; i++) {
      const slot = s[i]!;
      const m = sports ? SPORT_MATCHES.find((x) => x.ch.includes(c.n) && nowSlot + x.at === i) : undefined;
      if (m) {
        const end = s[Math.min(s.length - 1, i + m.len - 1)]!.stop;
        const title = m.titles[m.ch.indexOf(c.n) % m.titles.length]!;
        buf += `<programme start="${xmlDate(slot.start)}" stop="${xmlDate(end)}" channel="${c.epgId}"><title>${esc(title)}</title>`
          + (m.sub ? `<sub-title>${esc(m.sub)}</sub-title>` : '')
          + `<category lang="en">${m.cat}</category>`
          + (m.live?.includes(c.n) ? '<live/>' : '') + (m.rerun ? '<previously-shown/>' : '') + '</programme>\n';
        i += m.len - 1;
        continue;
      }
      buf += `<programme start="${xmlDate(slot.start)}" stop="${xmlDate(slot.stop)}" channel="${c.epgId}"><title>Programme ${slot.index}</title><desc>Synthetic listing for ${c.name}.</desc></programme>\n`;
    }
    yield (history?.(c, xmlDate) ?? '') + buf;
  }
  yield '</tv>\n';
}

export const MOVIE_GROUPS = ['Drama', 'Comedy', 'Documentary', 'Family'] as const;
export const SERIES_GROUPS = ['Drama', 'Comedy', 'Kids'] as const;
/** VOD fakes use the m3u8 extension so the dev player picks hls.js for the HLS test stream. */
export const VOD_EXT = 'm3u8';

export interface FakeMovie { n: number; name: string; categoryId: string; year: number; rating: string; added: number }
export interface FakeSeries { n: number; name: string; categoryId: string; seasons: number; perSeason: number }

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Versions mode: each title is listed three times, as a language and quality variant (prefix, then suffix). */
const VARIANT_PREFIX = ['EN - ', '|SE| ', '[DK] '] as const;
const VARIANT_QUALITY = [' 4K', ' FHD', ' HD'] as const;
/** In versions mode, item `n` is variant `(n - 1) % 3` of title `ceil(n / 3)`; otherwise its own title. */
const titleOf = (n: number, versions: boolean) => (versions ? Math.ceil(n / 3) : n);
const variant = (n: number, versions: boolean, name: string) =>
  (versions ? `${VARIANT_PREFIX[(n - 1) % 3]}${name}${VARIANT_QUALITY[(n - 1) % 3]}` : name);

export function movies(count: number, now: number, versions = false): FakeMovie[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const t = titleOf(n, versions);
    return {
      n,
      name: variant(n, versions, `Synthetic Film ${pad(t, 3)} (${2000 + (t % 25)})`),
      categoryId: String((i % MOVIE_GROUPS.length) + 1),
      year: 2000 + (t % 25),
      rating: (5 + ((n * 7) % 50) / 10).toFixed(1),
      added: Math.floor(now / 1000) - n * 3600,
    };
  });
}

export function seriesList(count: number, versions = false): FakeSeries[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { n, name: variant(n, versions, `Synthetic Series ${pad(titleOf(n, versions), 2)}`), categoryId: String((i % SERIES_GROUPS.length) + 1), seasons: 1 + (n % 3), perSeason: 3 + (n % 4) };
  });
}

/** Unique per series, season and episode. */
export const episodeId = (series: number, season: number, episode: number) => series * 10_000 + season * 100 + episode;

/** A solid-colour synthetic poster with its label. No real artwork. */
export function posterSvg(label: string): string {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  const safe = label.replace(/[^A-Za-z0-9 ]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">`
    + `<rect width="300" height="450" fill="hsl(${h} 45% 28%)"/>`
    + `<circle cx="150" cy="150" r="80" fill="hsl(${(h + 40) % 360} 80% 65%)"/>`
    + `<text x="24" y="410" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff">${safe}</text></svg>`;
}

export function m3u(chs: FakeChannel[], base: string, user: string, pass: string, vod?: { movies: FakeMovie[] }): string {
  const lines = ['#EXTM3U'];
  for (const c of chs) {
    lines.push(`#EXTINF:-1 tvg-id="${c.epgId}" tvg-name="${c.name}" tvg-chno="${c.n}" group-title="${c.group}",${c.name}`);
    lines.push(`${base}/live/${user}/${pass}/${c.n}.ts`);
  }
  if (vod) {
    for (const m of vod.movies.slice(0, 6)) {
      const group = MOVIE_GROUPS[Number(m.categoryId) - 1]!;
      lines.push(`#EXTINF:-1 tvg-logo="${base}/poster/m${m.n}.svg" group-title="${group}",${m.name}`);
      lines.push(`${base}/movie/${user}/${pass}/${m.n}.${VOD_EXT}`);
    }
    for (let season = 1; season <= 2; season++) {
      for (let e = 1; e <= 3; e++) {
        lines.push(`#EXTINF:-1 group-title="Series",Synthetic Series 01 S${pad(season, 2)}E${pad(e, 2)}`);
        lines.push(`${base}/series/${user}/${pass}/${episodeId(1, season, e)}.${VOD_EXT}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
