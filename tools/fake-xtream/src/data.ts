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

export function m3u(chs: FakeChannel[], base: string, user: string, pass: string): string {
  const lines = ['#EXTM3U'];
  for (const c of chs) {
    lines.push(`#EXTINF:-1 tvg-id="${c.epgId}" tvg-name="${c.name}" tvg-chno="${c.n}" group-title="${c.group}",${c.name}`);
    lines.push(`${base}/live/${user}/${pass}/${c.n}.ts`);
  }
  return `${lines.join('\n')}\n`;
}
