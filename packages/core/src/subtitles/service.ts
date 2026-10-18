import type { Storage } from '../storage.ts';
import type { FetchFn } from '../types.ts';
import { SUBTITLE_MAX_BYTES, decodeSubtitle, parseSubtitles, type SubtitleCue } from './parse.ts';

/** A subtitle file the user loaded for one title (a movie or an episode). */
export interface LoadedSubtitle {
  name: string;
  cues: SubtitleCue[];
}

/** Where a subtitle comes from: a link, or a file's bytes read on the device. */
export type SubtitleInput = { url: string } | { bytes: Uint8Array; name: string };

/** How many titles keep their loaded subtitles (most recently loaded first); older ones are dropped. */
export const SUBTITLE_KEEP = 20;

const INDEX_KEY = 'subtitles:index';
const keyOf = (sourceId: string, itemId: string) => `subtitles:${sourceId}:${itemId}`;

/** A failure whose message is shown to the user as is. */
export class SubtitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleError';
  }
}

const TOO_LARGE = 'That file is too large to be subtitles.';

/** The link's file name ("My Film.en.srt"), or its host when the path has none. */
function nameOf(u: URL): string {
  const last = u.pathname.split('/').filter(Boolean).pop();
  if (!last) return u.host;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export interface SubtitleServiceDeps {
  storage: Storage;
  /** The app's fetch (never the provider's refusal guard: a subtitle link can be anywhere). */
  fetch: FetchFn;
}

/**
 * Subtitles the user loads from a link or a file: downloaded and parsed on the device, kept per title in local
 * storage (the last SUBTITLE_KEEP titles). Nothing goes through our servers.
 */
export class SubtitleService {
  private readonly storage: Storage;
  private readonly fetch: FetchFn;
  /** Index writes one after another, so two loads never drop each other's entry. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: SubtitleServiceDeps) {
    this.storage = deps.storage;
    this.fetch = deps.fetch;
  }

  async load(sourceId: string, itemId: string, input: SubtitleInput): Promise<LoadedSubtitle> {
    const { bytes, name } = 'url' in input ? await this.download(input.url) : input;
    if (bytes.byteLength > SUBTITLE_MAX_BYTES) throw new SubtitleError(TOO_LARGE);
    const cues = parseSubtitles(decodeSubtitle(bytes));
    if (cues.length === 0) throw new SubtitleError('No subtitles found. Use an .srt or .vtt file.');
    const loaded: LoadedSubtitle = { name, cues };
    const key = keyOf(sourceId, itemId);
    await this.serial(async () => {
      await this.storage.setMeta(key, loaded);
      const index = (await this.storage.getMeta<string[]>(INDEX_KEY)) ?? [];
      const next = [key, ...index.filter((k) => k !== key)];
      for (const old of next.splice(SUBTITLE_KEEP)) await this.storage.setMeta(old, undefined);
      await this.storage.setMeta(INDEX_KEY, next);
    });
    return loaded;
  }

  async get(sourceId: string, itemId: string): Promise<LoadedSubtitle | undefined> {
    return (await this.storage.getMeta<LoadedSubtitle>(keyOf(sourceId, itemId))) ?? undefined;
  }

  async clear(sourceId: string, itemId: string): Promise<void> {
    const key = keyOf(sourceId, itemId);
    await this.serial(async () => {
      await this.storage.setMeta(key, undefined);
      const index = (await this.storage.getMeta<string[]>(INDEX_KEY)) ?? [];
      await this.storage.setMeta(INDEX_KEY, index.filter((k) => k !== key));
    });
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const p = this.chain.then(op, op);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async download(raw: string): Promise<{ bytes: Uint8Array; name: string }> {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      u = new URL('about:blank');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SubtitleError('Enter a link that starts with http:// or https://.');
    let res: Response;
    try {
      res = await this.fetch(u.toString());
    } catch {
      throw new SubtitleError("Couldn't download the subtitles. Check the link.");
    }
    if (!res.ok) throw new SubtitleError(`Couldn't download the subtitles (error ${res.status}).`);
    if (Number(res.headers.get('content-length') ?? 0) > SUBTITLE_MAX_BYTES) throw new SubtitleError(TOO_LARGE);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new SubtitleError("Couldn't download the subtitles. Check the link.");
    }
    return { bytes, name: nameOf(u) };
  }
}
