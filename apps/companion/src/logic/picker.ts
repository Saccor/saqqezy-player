import { normalize } from '@iptv/core';
import type { CompanionChannel } from '@iptv/companion-protocol';

/** One search key per channel (same order): words of the shown name, the original name and the group. */
export interface SearchKeys {
  text: string[];
  numbers: string[];
}

/** Built once per channel list (50k channels: a few tens of ms), then reused for every keystroke. */
export function buildSearchKeys(channels: readonly CompanionChannel[], label?: (c: CompanionChannel) => string): SearchKeys {
  const text = new Array<string>(channels.length);
  const numbers = new Array<string>(channels.length);
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i]!;
    const shown = label ? label(c) : (c.displayName ?? c.name);
    const parts = shown === c.name ? [shown, c.group] : [shown, c.name, c.group];
    text[i] = normalize(parts.join(' \u0001 '));
    numbers[i] = String(c.number);
  }
  return { text, numbers };
}

/**
 * Indices of the channels matching `query`: every word must appear in the name, the original name or the group
 * (ignoring case and diacritics, via core `normalize`), or be a prefix of the channel number.
 */
export function filterChannels(keys: SearchKeys, query: string): number[] {
  const words = normalize(query).split(/\s+/).filter((w) => w.length > 0);
  const n = keys.text.length;
  const out: number[] = [];
  if (words.length === 0) {
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  const digits = words.map((w) => /^\d+$/.test(w));
  for (let i = 0; i < n; i++) {
    const t = keys.text[i]!;
    let ok = true;
    for (let w = 0; w < words.length; w++) {
      const word = words[w]!;
      if (digits[w] ? keys.numbers[i]!.startsWith(word) : t.includes(word)) continue;
      ok = false;
      break;
    }
    if (ok) out.push(i);
  }
  return out;
}
