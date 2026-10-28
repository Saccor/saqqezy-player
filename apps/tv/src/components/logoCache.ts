import { lruSet } from '@iptv/core';

/**
 * Bounded LRU of channel logo URLs (at most 200 by default). Rows only render logos the cache considers
 * usable: a logo that failed to load is remembered, so the row shows the number tile instead of retrying on
 * every scroll. Evicted entries may be tried again later. The list is virtualised, so at most the rendered
 * rows hold a logo texture at any time; the renderer frees textures nobody references.
 */
export class LogoCache {
  private readonly entries = new Map<string, { failed: boolean }>();

  constructor(private readonly max = 200) {}

  /** Records a use, moving `url` to the most recent end. */
  touch(url: string): void {
    lruSet(this.entries, url, this.entries.get(url) ?? { failed: false }, this.max);
  }

  markFailed(url: string): void {
    this.touch(url);
    const e = this.entries.get(url);
    if (e) e.failed = true;
  }

  /** True when the row should try to draw this logo. */
  usable(url: string | undefined): url is string {
    if (!url) return false;
    return this.entries.get(url)?.failed !== true;
  }

  has(url: string): boolean {
    return this.entries.has(url);
  }

  size(): number {
    return this.entries.size;
  }
}

/** The app's one logo cache. */
export const logoCache = new LogoCache();
