import { SaxesParser } from 'saxes';
import type { Programme } from '../types.ts';
import { parseXmltvDate } from './date.ts';

/** Fields read only for sports detection (never stored with the programme). */
export interface ProgrammeExtra { categories?: string[]; live?: true; rerun?: true; subTitle?: string; icon?: string }

export type XmltvItem =
  | { type: 'channel'; id: string; names: string[] }
  | { type: 'programme'; programme: Programme; extra?: ProgrammeExtra };

export interface XmltvStats { channels: number; programmes: number; skipped: number }

interface ProgState {
  epgId: string; start: number; stop: number; title?: string; desc?: string;
  categories?: string[]; live?: true; rerun?: true; subTitle?: string; icon?: string;
  /** Written without `stop`: it gets one from the next programme on its channel. */
  noStop?: true;
}

/**
 * Longest a programme without `stop` (optional in the DTD) runs: it ends where the next one on its channel starts, but
 * no later than this, and the last one on its channel runs this long.
 */
export const NO_STOP_MAX_MS = 4 * 3600_000;

export async function* parseXmltv(
  chunks: AsyncIterable<string>,
  stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 },
): AsyncGenerator<XmltvItem> {
  const parser = new SaxesParser();
  const queue: XmltvItem[] = [];

  let channel: { id: string; names: string[] } | null = null;
  let prog: ProgState | null = null;
  let textTarget: 'name' | 'title' | 'desc' | 'category' | 'subTitle' | null = null;
  let text = '';
  /** Per channel, the programme without `stop` still waiting for the next one's start: at most one per channel. */
  const open = new Map<string, ProgState>();

  const emit = (p: ProgState) => {
    const programme: Programme = { epgId: p.epgId, start: p.start, stop: p.stop, title: p.title ?? '' };
    if (p.desc) programme.desc = p.desc;
    const extra: ProgrammeExtra = {};
    if (p.categories) extra.categories = p.categories;
    if (p.live) extra.live = true;
    if (p.rerun) extra.rerun = true;
    if (p.subTitle) extra.subTitle = p.subTitle;
    if (p.icon) extra.icon = p.icon;
    queue.push(Object.keys(extra).length ? { type: 'programme', programme, extra } : { type: 'programme', programme });
    stats.programmes++;
  };
  /** Ends the channel's open programme at `next` (capped; the cap alone without a later start) and emits it. */
  const close = (epgId: string, next?: number) => {
    const p = open.get(epgId);
    if (!p) return;
    open.delete(epgId);
    const cap = p.start + NO_STOP_MAX_MS;
    p.stop = next !== undefined && next > p.start ? Math.min(next, cap) : cap;
    emit(p);
  };

  parser.on('error', () => { stats.skipped++; });
  parser.on('opentag', (node) => {
    const a = node.attributes as Record<string, string>;
    if (node.name === 'channel' && a.id) channel = { id: a.id, names: [] };
    else if (node.name === 'programme') {
      prog = { epgId: a.channel ?? '', start: parseXmltvDate(a.start ?? ''), stop: parseXmltvDate(a.stop ?? '') };
      // No stop (or an empty one) leaves it open; a stop that is there but unreadable is skipped as before.
      if (!a.stop?.trim()) prog.noStop = true;
    } else if (node.name === 'display-name' && channel) { textTarget = 'name'; text = ''; }
    else if (!prog) return;
    else if (node.name === 'title' && prog.title === undefined) { textTarget = 'title'; text = ''; }
    else if (node.name === 'desc' && prog.desc === undefined) { textTarget = 'desc'; text = ''; }
    else if (node.name === 'sub-title' && prog.subTitle === undefined) { textTarget = 'subTitle'; text = ''; }
    else if (node.name === 'category') { textTarget = 'category'; text = ''; }
    else if (node.name === 'live') prog.live = true;
    else if (node.name === 'previously-shown') prog.rerun = true;
    else if (node.name === 'icon' && a.src && prog.icon === undefined) prog.icon = a.src;
  });
  const onText = (t: string) => { if (textTarget) text += t; };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('closetag', (node) => {
    if (textTarget && (node.name === 'display-name' || node.name === 'title' || node.name === 'desc'
      || node.name === 'category' || node.name === 'sub-title')) {
      const value = text.trim();
      if (textTarget === 'name' && channel && value) channel.names.push(value);
      if (prog && value) {
        if (textTarget === 'title') prog.title = value;
        else if (textTarget === 'desc') prog.desc = value;
        else if (textTarget === 'subTitle') prog.subTitle = value;
        else if (textTarget === 'category') (prog.categories ??= []).push(value);
      }
      textTarget = null;
      return;
    }
    if (node.name === 'channel' && channel) {
      queue.push({ type: 'channel', ...channel });
      stats.channels++;
      channel = null;
    } else if (node.name === 'programme' && prog) {
      const p = prog;
      prog = null;
      if (!p.epgId || !Number.isFinite(p.start) || (!p.noStop && (!Number.isFinite(p.stop) || p.stop <= p.start))) {
        stats.skipped++;
        return;
      }
      if (open.size) close(p.epgId, p.start);
      if (p.noStop) open.set(p.epgId, p);
      else emit(p);
    }
  });

  for await (const chunk of chunks) {
    parser.write(chunk);
    // splice(0) drains in O(n); shift() in a loop would be O(n²) on big chunks.
    for (const item of queue.splice(0)) yield item;
  }
  parser.close();
  // The last open programme of each channel has no successor.
  for (const epgId of [...open.keys()]) close(epgId);
  for (const item of queue.splice(0)) yield item;
}
