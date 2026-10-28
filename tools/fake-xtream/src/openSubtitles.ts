import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A fake of the OpenSubtitles REST v1 API (search, download, file) for tests and the dev app: every title has the
 * same synthetic subtitles in a few languages. No real subtitles. The key is `fake-key`; file id 999 answers like a
 * spent daily quota (406).
 */
const FAKE_OPENSUBTITLES_KEY = 'fake-key';
/** A search with this moviehash marks each language's third file as made for the exact file (`moviehash_match`). */
const FAKE_MATCHING_HASH = '0123456789abcdef';

const LANGS: [string, number][] = [['en', 3], ['sv', 2], ['de', 1], ['fr', 1], ['es', 1]];
const QUOTA_FILE = 999;

function entries(languages: string[] | undefined, hashMatches: boolean) {
  const out: unknown[] = [];
  LANGS.forEach(([language, count], li) => {
    if (languages && !languages.includes(language)) return;
    for (let n = 1; n <= count; n++) {
      const fileId = (li + 1) * 1000 + n;
      out.push({
        id: String(fileId * 10),
        type: 'subtitle',
        attributes: {
          language, download_count: 1000 - n * 100, hearing_impaired: n === 2, machine_translated: false, ai_translated: n === 3,
          from_trusted: n === 1, release: `Synthetic.Release.${language}.${n}`, moviehash_match: hashMatches && n === 3,
          // Frame rates: the first file PAL (25), the second film (23.976), the third unknown.
          ...(n === 1 ? { fps: 25 } : n === 2 ? { fps: 23.976 } : {}),
          files: [{ file_id: fileId, file_name: `synthetic.${language}.${n}.srt` }],
        },
      });
    }
  });
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ts = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},000`;

/** A synthetic SRT: a numbered cue every 5 s for 10 minutes, naming the file. */
function syntheticSrt(fileId: number): string {
  const lang = LANGS[Math.floor(fileId / 1000) - 1]?.[0] ?? 'xx';
  const cues: string[] = [];
  for (let i = 0; i < 120; i++) cues.push(`${i + 1}\n${ts(1 + i * 5)} --> ${ts(4 + i * 5)}\nSynthetic subtitle ${i + 1} (${lang})\n`);
  return cues.join('\n');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += String(chunk);
  return s;
}

/** Handles `/opensubtitles/...`; false when the path is not one of its routes. */
export async function handleOpenSubtitles(req: IncomingMessage, res: ServerResponse, url: URL, base: string): Promise<boolean> {
  const file = /^\/opensubtitles\/file\/(\d+)\.srt$/.exec(url.pathname);
  if (file) {
    res.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8' });
    res.end(syntheticSrt(Number(file[1])));
    return true;
  }
  if (!url.pathname.startsWith('/opensubtitles/api/v1/')) return false;
  if (req.headers['api-key'] !== FAKE_OPENSUBTITLES_KEY) {
    json(res, 401, { message: 'You cannot consume this service' });
    return true;
  }
  const route = url.pathname.slice('/opensubtitles/api/v1'.length);
  if (route === '/subtitles' && req.method === 'GET') {
    const languages = url.searchParams.get('languages')?.split(',').filter(Boolean);
    const data = entries(languages, url.searchParams.get('moviehash') === FAKE_MATCHING_HASH);
    json(res, 200, { total_pages: 1, total_count: data.length, per_page: 60, page: 1, data });
    return true;
  }
  if (route === '/download' && req.method === 'POST') {
    let fileId: unknown;
    try {
      fileId = (JSON.parse(await readBody(req)) as { file_id?: unknown }).file_id;
    } catch {
      fileId = undefined;
    }
    if (typeof fileId !== 'number') {
      json(res, 400, { message: 'file_id required' });
      return true;
    }
    if (fileId === QUOTA_FILE) {
      json(res, 406, { message: 'You have downloaded your allowed 5 subtitles for 24h', remaining: 0 });
      return true;
    }
    json(res, 200, { link: `${base}/opensubtitles/file/${fileId}.srt`, file_name: `synthetic.${fileId}.srt`, requests: 1, remaining: 4 });
    return true;
  }
  json(res, 404, { message: 'Not found' });
  return true;
}
