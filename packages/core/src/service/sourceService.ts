import { EpgMatcher, epgKey, inWindow, nowNext } from '../epg/window.ts';
import { SourceAuthError, SourceNetworkError } from '../errors.ts';
import { sanitizeSettings, type AppSettings } from '../settings.ts';
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
const SHORT_EPG_CONCURRENCY = 6;
const defaultId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class SourceService {
  private readonly storage: Storage;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly epgRefreshing = new Set<string>();
  private shortEpgActive = 0;
  private readonly shortEpgWaiting: (() => void)[] = [];

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
    try {
      await this.saveChannels(source.id, channels, result);
      await this.storage.putSource(source);
      if (!(await this.getActiveSourceId())) await this.setActiveSource(source.id);
    } catch (err) {
      try {
        await this.storage.deleteSource(source.id);
        if ((await this.getActiveSourceId()) === source.id) await this.storage.setMeta('activeSource', null);
      } catch {
        // Best-effort cleanup; the original error is the one worth reporting.
      }
      throw err;
    }
    return { source, result };
  }

  updateSource(source: SourceConfig, onProgress?: Progress): Promise<IngestResult> {
    return this.withLock(source.id, async () => {
      const { channels, result } = await this.fetchChannels(source, onProgress);
      await this.storage.putSource(source);
      await this.saveChannels(source.id, channels, result);
      await this.storage.setMeta(`epgAt:${source.id}`, 0);
      return result;
    });
  }

  deleteSource(id: string): Promise<void> {
    return this.withLock(id, async () => {
      await this.storage.clearProgrammes(await this.currentEpgKey(id));
      const staging = await this.stagingGen(id);
      if (staging !== undefined) await this.storage.clearProgrammes(`${id}@${staging}`);
      await this.storage.deleteSource(id);
      if ((await this.getActiveSourceId()) === id) {
        const [next] = await this.storage.listSources();
        await this.storage.setMeta('activeSource', next?.id ?? null);
      }
    });
  }

  refreshPlaylist(id: string, onProgress?: Progress): Promise<IngestResult> {
    return this.withLock(id, async () => {
      const source = await this.requireSource(id);
      const { channels, result } = await this.fetchChannels(source, onProgress);
      if (!(await this.sourceExists(id))) return { channelCount: 0, skipped: 0 };
      await this.saveChannels(id, channels, result);
      return result;
    });
  }

  async getSettings(): Promise<AppSettings> {
    return sanitizeSettings(await this.storage.getMeta<unknown>('settings'));
  }

  async saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
    const next = sanitizeSettings({ ...(await this.getSettings()), ...defined });
    await this.storage.setMeta('settings', next);
    return next;
  }

  /** Drops channels and guide data; the source and the user's flags stay. */
  clearCachedData(id: string): Promise<void> {
    return this.withLock(id, async () => {
      await this.requireSource(id);
      const current = await this.currentGen(id);
      const staging = await this.stagingGen(id);
      await this.storage.clearProgrammes(id);
      if (current !== undefined) await this.storage.clearProgrammes(`${id}@${current}`);
      if (staging !== undefined) await this.storage.clearProgrammes(`${id}@${staging}`);
      await this.storage.setMeta(`epgGen:${id}`, null);
      await this.storage.setMeta(`epgStaging:${id}`, null);
      await this.storage.replaceChannels(id, []);
      await this.storage.setMeta(`playlistAt:${id}`, 0);
      await this.storage.setMeta(`epgAt:${id}`, 0);
    });
  }

  async needsPlaylistRefresh(id: string): Promise<boolean> {
    const at = (await this.storage.getMeta<number>(`playlistAt:${id}`)) ?? 0;
    if (!at) return true;
    const hours = (await this.getSettings()).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
  }

  async needsEpgRefresh(id: string): Promise<boolean> {
    const at = (await this.storage.getMeta<number>(`epgAt:${id}`)) ?? 0;
    if (!at) return true;
    const hours = (await this.getSettings()).autoRefreshHours;
    if (hours === 0) return false;
    return this.now() - at > hours * 3600_000;
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

  refreshEpg(id: string, onProgress?: Progress): Promise<EpgResult> {
    return this.withLock(id, async () => {
      this.epgRefreshing.add(id);
      try {
        return await this.refreshEpgLocked(id, onProgress);
      } finally {
        this.epgRefreshing.delete(id);
      }
    });
  }

  private async refreshEpgLocked(id: string, onProgress?: Progress): Promise<EpgResult> {
    const source = await this.requireSource(id);
    const url = source.kind === 'm3u' ? source.epgUrl : this.xtream(source).xmltvUrl();
    if (!url) {
      const leftover = await this.stagingGen(id);
      if (leftover !== undefined) {
        await this.storage.clearProgrammes(`${id}@${leftover}`);
        await this.storage.setMeta(`epgStaging:${id}`, null);
      }
      await this.storage.clearProgrammes(await this.currentEpgKey(id));
      await this.storage.setMeta(`epgAt:${id}`, this.now());
      return { programmes: 0, skipped: 0 };
    }
    const res = await this.get(url);
    if (!(await this.sourceExists(id))) return { programmes: 0, skipped: 0 };
    const channels = await this.storage.getChannels(id);

    const staleStaging = await this.stagingGen(id);
    const current = await this.currentGen(id);
    // After a crash between "set epgGen" and "clear epgStaging" the staging key IS the live one.
    if (staleStaging !== undefined && staleStaging !== current) {
      await this.storage.clearProgrammes(`${id}@${staleStaging}`);
    }
    const oldKey = current === undefined ? id : `${id}@${current}`;
    const newGen = (current ?? 0) + 1;
    const newKey = `${id}@${newGen}`;
    await this.storage.setMeta(`epgStaging:${id}`, newGen);

    const matcher = new EpgMatcher(channels);
    const stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 };
    const now = this.now();
    let batch: Programme[] = [];
    let stored = 0;
    let storageFailure: { error: unknown } | undefined;
    const store = async (rows: Programme[]) => {
      try {
        await this.storage.addProgrammes(newKey, rows);
      } catch (error) {
        storageFailure = { error };
        throw error;
      }
    };
    try {
      for await (const item of parseXmltv(responseText(res, url), stats)) {
        if (item.type === 'channel') {
          matcher.addXmltvChannel(item.id, item.names);
          continue;
        }
        const key = matcher.resolve(item.programme.epgId);
        if (!key || !inWindow(item.programme, now)) continue;
        batch.push({ ...item.programme, epgId: key });
        if (batch.length >= EPG_BATCH) {
          await store(batch);
          stored += batch.length;
          batch = [];
          onProgress?.({ phase: 'epg', count: stored });
        }
      }
      if (batch.length) await store(batch);
    } catch {
      try {
        await this.storage.clearProgrammes(newKey);
        await this.storage.setMeta(`epgStaging:${id}`, null);
      } catch {
        // Best-effort cleanup; the original failure is the one worth reporting.
      }
      if (storageFailure) throw (storageFailure as { error: unknown }).error;
      throw new SourceNetworkError('The guide download was interrupted.');
    }
    stored += batch.length;
    onProgress?.({ phase: 'epg', count: stored });
    await this.storage.setMeta(`epgGen:${id}`, newGen);
    await this.storage.setMeta(`epgStaging:${id}`, null);
    await this.storage.clearProgrammes(oldKey);
    await this.storage.setMeta(`epgAt:${id}`, now);
    return { programmes: stored, skipped: stats.skipped };
  }

  async programmesFor(id: string, channels: Channel[], from: number, to: number): Promise<Map<string, Programme[]>> {
    const keys = channels.map(epgKey);
    const progs = await this.storage.getProgrammes(await this.currentEpgKey(id), keys, from, to);
    const byKey = new Map<string, Programme[]>();
    for (const p of progs) {
      const list = byKey.get(p.epgId) ?? [];
      list.push(p);
      byKey.set(p.epgId, list);
    }
    return new Map(channels.map((c) => [c.id, byKey.get(epgKey(c)) ?? []]));
  }

  /** Now/next from stored programmes only: never touches the network (see `shortEpgFor` for the fallback). */
  async nowNextFor(id: string, channels: Channel[]): Promise<Map<string, { now?: Programme; next?: Programme }>> {
    const now = this.now();
    const stored = await this.programmesFor(id, channels, now, now + 6 * 3600_000);
    return new Map(channels.map((c) => [c.id, nowNext(stored.get(c.id) ?? [], now)]));
  }

  /** True while a guide refresh of source `id` is running. */
  isRefreshingEpg(id: string): boolean {
    return this.epgRefreshing.has(id);
  }

  /**
   * Xtream short EPG for channels without stored programmes. At most `SHORT_EPG_CONCURRENCY` requests run at
   * once across all calls; skipped (empty map) while a guide refresh of the source runs. Only channels whose
   * lookup succeeded are in the result.
   */
  async shortEpgFor(id: string, channels: Channel[]): Promise<Map<string, { now?: Programme; next?: Programme }>> {
    const out = new Map<string, { now?: Programme; next?: Programme }>();
    if (this.isRefreshingEpg(id)) return out;
    const source = (await this.storage.listSources()).find((s) => s.id === id);
    if (source?.kind !== 'xtream') return out;
    const client = this.xtream(source);
    await Promise.all(channels.map(async (c) => {
      const streamId = Number(/:x(\d+)$/.exec(c.id)?.[1]);
      if (!streamId) return;
      await this.shortEpgSlot();
      try {
        if (this.isRefreshingEpg(id)) return;
        const list = await client.shortEpg(streamId, epgKey(c));
        out.set(c.id, nowNext(list, this.now()));
      } catch {
        // No EPG is an acceptable outcome; the UI shows the channel without programme info.
      } finally {
        this.releaseShortEpgSlot();
      }
    }));
    return out;
  }

  // ---- internals ----

  private shortEpgSlot(): Promise<void> {
    if (this.shortEpgActive < SHORT_EPG_CONCURRENCY) {
      this.shortEpgActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.shortEpgWaiting.push(resolve));
  }

  /** Hands the slot straight to the next waiter (the active count stays), or frees it. */
  private releaseShortEpgSlot(): void {
    const next = this.shortEpgWaiting.shift();
    if (next) next();
    else this.shortEpgActive--;
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  private async sourceExists(id: string): Promise<boolean> {
    return (await this.storage.listSources()).some((x) => x.id === id);
  }

  private async currentGen(id: string): Promise<number | undefined> {
    const g = await this.storage.getMeta<number>(`epgGen:${id}`);
    return typeof g === 'number' ? g : undefined;
  }

  private async stagingGen(id: string): Promise<number | undefined> {
    const g = await this.storage.getMeta<number>(`epgStaging:${id}`);
    return typeof g === 'number' ? g : undefined;
  }

  /** Storage key of the live EPG generation; legacy (pre-generation) data lives under the bare id. */
  private async currentEpgKey(id: string): Promise<string> {
    const g = await this.currentGen(id);
    return g === undefined ? id : `${id}@${g}`;
  }

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
