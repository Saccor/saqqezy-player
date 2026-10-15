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

export function* xmltv(chs: FakeChannel[], now: number): Generator<string> {
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="fake-xtream">\n';
  for (const c of chs) yield `<channel id="${c.epgId}"><display-name>${c.name}</display-name></channel>\n`;
  const s = slots(now);
  for (const c of chs) {
    let buf = '';
    for (const slot of s) {
      buf += `<programme start="${xmlDate(slot.start)}" stop="${xmlDate(slot.stop)}" channel="${c.epgId}"><title>Programme ${slot.index}</title><desc>Synthetic listing for ${c.name}.</desc></programme>\n`;
    }
    yield buf;
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

export function movies(count: number, now: number): FakeMovie[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      n,
      name: `Synthetic Film ${pad(n, 3)} (${2000 + (n % 25)})`,
      categoryId: String((i % MOVIE_GROUPS.length) + 1),
      year: 2000 + (n % 25),
      rating: (5 + ((n * 7) % 50) / 10).toFixed(1),
      added: Math.floor(now / 1000) - n * 3600,
    };
  });
}

export function seriesList(count: number): FakeSeries[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { n, name: `Synthetic Series ${pad(n, 2)}`, categoryId: String((i % SERIES_GROUPS.length) + 1), seasons: 1 + (n % 3), perSeason: 3 + (n % 4) };
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
