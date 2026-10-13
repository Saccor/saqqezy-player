import { SaxesParser } from 'saxes';
import type { Programme } from '../types.ts';
import { parseXmltvDate } from './date.ts';

export type XmltvItem =
  | { type: 'channel'; id: string; names: string[] }
  | { type: 'programme'; programme: Programme };

export interface XmltvStats { channels: number; programmes: number; skipped: number }

export async function* parseXmltv(
  chunks: AsyncIterable<string>,
  stats: XmltvStats = { channels: 0, programmes: 0, skipped: 0 },
): AsyncGenerator<XmltvItem> {
  const parser = new SaxesParser();
  const queue: XmltvItem[] = [];

  let channel: { id: string; names: string[] } | null = null;
  let prog: { epgId: string; start: number; stop: number; title?: string; desc?: string } | null = null;
  let textTarget: 'name' | 'title' | 'desc' | null = null;
  let text = '';

  parser.on('error', () => { stats.skipped++; });
  parser.on('opentag', (node) => {
    const a = node.attributes as Record<string, string>;
    if (node.name === 'channel' && a.id) channel = { id: a.id, names: [] };
    else if (node.name === 'programme') {
      prog = { epgId: a.channel ?? '', start: parseXmltvDate(a.start ?? ''), stop: parseXmltvDate(a.stop ?? '') };
    } else if (node.name === 'display-name' && channel) { textTarget = 'name'; text = ''; }
    else if (node.name === 'title' && prog && prog.title === undefined) { textTarget = 'title'; text = ''; }
    else if (node.name === 'desc' && prog && prog.desc === undefined) { textTarget = 'desc'; text = ''; }
  });
  parser.on('text', (t) => { if (textTarget) text += t; });
  parser.on('closetag', (node) => {
    if (textTarget && (node.name === 'display-name' || node.name === 'title' || node.name === 'desc')) {
      const value = text.trim();
      if (textTarget === 'name' && channel && value) channel.names.push(value);
      if (textTarget === 'title' && prog) prog.title = value;
      if (textTarget === 'desc' && prog && value) prog.desc = value;
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
      if (!p.epgId || !Number.isFinite(p.start) || !Number.isFinite(p.stop) || p.stop <= p.start) {
        stats.skipped++;
        return;
      }
      const programme: Programme = { epgId: p.epgId, start: p.start, stop: p.stop, title: p.title ?? '' };
      if (p.desc) programme.desc = p.desc;
      queue.push({ type: 'programme', programme });
      stats.programmes++;
    }
  });

  for await (const chunk of chunks) {
    parser.write(chunk);
    // splice(0) drains in O(n); shift() in a loop would be O(n²) on big chunks.
    for (const item of queue.splice(0)) yield item;
  }
  parser.close();
  for (const item of queue.splice(0)) yield item;
}
