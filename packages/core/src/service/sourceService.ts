import { EPG_MAX_AGE_MS, PLAYLIST_MAX_AGE_MS } from '../constants.ts';
import { EpgMatcher, epgKey, inWindow, nowNext } from '../epg/window.ts';
import { SourceAuthError, SourceNetworkError } from '../errors.ts';
import { ChannelIndex, type UserFlags } from '../index/channelIndex.ts';
import { parseM3u, type M3uEntry, type ParseStats } from '../m3u/parse.ts';
import { m3uEntriesToChannels } from '../m3u/toChannels.ts';
import { responseText } from '../net/textStream.ts';
import type { Storage } from '../storage.ts';
import { splitLines } from '../text/lines.ts';
import type {
  Channel, FetchFn, M3uSourceConfig, Programme, SourceConfig, XtreamSourceConfig,
} from '../types.ts';
import { parseXmltv, type XmltvStats } from '../xmltv/parse.ts';
import { XtreamClient } from '../xtream/client.ts';
import { xtreamToChannels } from '../xtream/toChannels.ts';

export type NewSource = Omit<XtreamSourceConfig, 'id'> | Omit<M3uSourceConfig, 'id'>;
export type Progress = (p: { phase: 'playlist' | 'epg'; count: number }) => void;
export interface IngestResult { channelCount: number; skipped: number }
export interface EpgResult { programmes: number; skipped: number }
export interface SourceServiceDeps { storage: Storage; fetch: FetchFn; now?: () => number; newId?: () => string }

const PROGRESS_EVERY = 2000;
const EPG_BATCH = 5000;
const defaultId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class SourceService {
  private readonly storage: Storage;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: SourceServiceDeps) {
    this.storage = deps.storage;
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? defaultId;
  }

  listSources(): Promise<SourceConfig[]> {
    return this.storage.listSources();
  }

  async getActiveSourceId(): Promise<string | undefined> {
    return (await this.storage.getMeta<string>('activeSource')) ?? undefined;
  }

  setActiveSource(id: string): Promise<void> {
    return this.storage.setMeta('activeSource', id);
  }

  async addSource(input: NewSource, onProgress?: Progress) {
    const source = { ...input, id: this.newId() } as SourceConfig;
    const { channels, result } = await this.fetchChannels(source, onProgress);
    await this.storage.putSource(source);
    await this.saveChannels(source.id, channels, result);
    if (!(await this.getActiveSourceId())) await this.setActiveSource(source.id);
    return { source, result };
  }

  async updateSource(source: SourceConfig, onProgress?: Progress): Promise<IngestResult> {
    const { channels, result } = await this.fetchChannels(source, onProgress);
    await this.storage.putSource(source);
    await this.saveChannels(source.id, channels, result);
    await this.storage.setMeta(`epgAt:${source.id}`, 0);
    return result;
  }

  async deleteSource(id: string): Promise<void> {
    await this.storage.deleteSource(id);
    if ((await this.getActiveSourceId()) === id) {
      const [next] = await this.storage.listSources();
      await this.storage.setMeta('activeSource', next?.id ?? null);
    }
  }

  async refreshPlaylist(id: string, onProgress?: Progress): Promise<IngestResult> {
    const source = await this.requireSource(id);
    const { channels, result } = await this.fetchChannels(source, onProgress);
    await this.saveChannels(id, channels, result);
    return result;
  }

  async needsPlaylistRefresh(id: string): Promise<boolean> {
    const at = (await this.storage.getMeta<number>(`playlistAt:${id}`)) ?? 0;
    return this.now() - at > PLAYLIST_MAX_AGE_MS;
  }

  async needsEpgRefresh(id: string): Promise<boolean> {
    const at = (await this.storage.getMeta<number>(`epgAt:${id}`)) ?? 0;
    return this.now() - at > EPG_MAX_AGE_MS;
  }

  async loadIndex(id: string): Promise<ChannelIndex> {
    const [channels, flags] = await Promise.all([
      this.storage.getChannels(id),
      this.storage.getMeta<UserFlags>(`flags:${id}`),
    ]);
    return new ChannelIndex(channels, flags ?? undefined);
  }

  saveFlags(id: string, index: ChannelIndex): Promise<void> {
    return this.storage.setMeta(`flags:${id}`, index.flags());
  }

  async refreshEpg(id: string, onProgress?: Progress): Promise<EpgResult> {
    const source = await this.requireSource(id);
    const url = source.kind === 'm3u' ? source.epgUrl : this.xtream(source).xmltvUrl();
    if (!url) return { programmes: 0, skipped: 0 };
    const res = await this.get(url);
    const matcher = new EpgMatcher(await this.storage.getChannels(id));
    await this.storage.clearProgrammes(id);
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const now = this.now();
    let batch: Programme[] = [];
    let stored = 0;
    for await (const item of parseXmltv(responseText(res, url), stats)) {
      if (item.type === 'channel') {
        matcher.addXmltvChannel(item.id, item.names);
        continue;
      }
      const key = matcher.resolve(item.programme.epgId);
      if (!key || !inWindow(item.programme, now)) continue;
      batch.push({ ...item.programme, epgId: key });
      if (batch.length >= EPG_BATCH) {
        await this.storage.addProgrammes(id, batch);
        stored += batch.length;
        batch = [];
        onProgress?.({ phase: 'epg', count: stored });
      }
    }
    if (batch.length) await this.storage.addProgrammes(id, batch);
    stored += batch.length;
    onProgress?.({ phase: 'epg', count: stored });
    await this.storage.setMeta(`epgAt:${id}`, now);
    return { programmes: stored, skipped: stats.skipped };
  }

  async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
    const keys = channels.map(epgKey);
    const progs = await this.storage.getProgrammes(id, keys, from, to);
    const byKey = new Map<string, Programme[]>();
    for (const p of progs) {
      const list = byKey.get(p.epgId) ?? [];
      list.push(p);
      byKey.set(p.epgId, list);
    }
    return new Map(channels.map((c) => [c.id, byKey.get(epgKey(c)) ?? []]));
  }

  async nowNextFor(id: string, channels: Channel[]): Promise<Map<string, { now?: Programme; next?: Programme }>> {
    const now = this.now();
    const stored = await this.programmesFor(id, channels, now, now + 6 * 3600_000);
    const out = new Map<string, { now?: Programme; next?: Programme }>();
    const source = (await this.storage.listSources()).find((s) => s.id === id);
    const client = source?.kind === 'xtream' ? this.xtream(source) : undefined;
    await Promise.all(channels.map(async (c) => {
      let nn = nowNext(stored.get(c.id) ?? [], now);
      const streamId = Number(/:x(\d+)$/.exec(c.id)?.[1]);
      if (!nn.now && client && streamId) {
        try {
          nn = nowNext(await client.shortEpg(streamId, epgKey(c)), now);
        } catch {
          // No EPG is an acceptable outcome; the UI shows the channel without programme info.
        }
      }
      out.set(c.id, nn);
    }));
    return out;
  }

  // ---- internals ----

  private async requireSource(id: string): Promise<SourceConfig> {
    const s = (await this.storage.listSources()).find((x) => x.id === id);
    if (!s) throw new Error(`Unknown source ${id}`);
    return s;
  }

  private xtream(s: XtreamSourceConfig): XtreamClient {
    return new XtreamClient(s, this.fetchFn);
  }

  private async get(url: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch {
      throw new SourceNetworkError('Could not reach the provider.');
    }
    if (res.status === 401 || res.status === 403) throw new SourceAuthError();
    if (!res.ok) throw new SourceNetworkError(`The provider returned an error (HTTP ${res.status}).`, res.status);
    return res;
  }

  private async fetchChannels(source: SourceConfig, onProgress?: Progress): Promise<{ channels: Channel[]; result: IngestResult }> {
    if (source.kind === 'xtream') {
      const client = this.xtream(source);
      await client.authenticate();
      const [categories, streams] = await Promise.all([client.liveCategories(), client.liveStreams()]);
      const channels = xtreamToChannels(source.id, client, categories, streams, 'ts');
      onProgress?.({ phase: 'playlist', count: channels.length });
      return { channels, result: { channelCount: channels.length, skipped: 0 } };
    }
    const res = await this.get(source.playlistUrl);
    const stats: ParseStats = { entries: 0, skipped: 0 };
    const entries: M3uEntry[] = [];
    for await (const e of parseM3u(splitLines(responseText(res, source.playlistUrl)), stats)) {
      entries.push(e);
      if (entries.length % PROGRESS_EVERY === 0) onProgress?.({ phase: 'playlist', count: entries.length });
    }
    onProgress?.({ phase: 'playlist', count: entries.length });
    const channels = m3uEntriesToChannels(source.id, entries);
    if (channels.length === 0) throw new SourceNetworkError('The playlist contains no channels.');
    return { channels, result: { channelCount: channels.length, skipped: stats.skipped } };
  }

  private async saveChannels(id: string, channels: Channel[], result: IngestResult): Promise<void> {
    await this.storage.replaceChannels(id, channels);
    await this.storage.setMeta(`playlistAt:${id}`, this.now());
    await this.storage.setMeta(`parseStats:${id}`, result);
  }
}
