const CHUNK = 64 * 1024;

async function* chunked(parts: Iterable<string>): AsyncGenerator<string> {
  let buf = '';
  for (const p of parts) {
    buf += p;
    if (buf.length >= CHUNK) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}

export function m3uChunks(count: number): AsyncGenerator<string> {
  return chunked((function* () {
    yield '#EXTM3U\n';
    for (let i = 1; i <= count; i++) {
      yield `#EXTINF:-1 tvg-id="c${i}.test" tvg-name="Channel ${i}" tvg-logo="http://example.test/l/${i}.png" group-title="Group ${i % 300}",Channel ${i}\n`;
      yield `http://example.test/live/u/p/${i}.ts\n`;
    }
  })());
}

/**
 * Roughly `channels * perChannel * 170` bytes of XMLTV, generated lazily. `uniqueTitles` cycles that many titles.
 * `titlesPerChannel` gives every channel its own block of that many titles, so new titles appear throughout the file.
 */
export function xmltvChunks(
  channels: number,
  perChannel: number,
  opts: { uniqueTitles?: number; titlesPerChannel?: number } = {},
): AsyncGenerator<string> {
  return chunked((function* () {
    yield '<?xml version="1.0" encoding="UTF-8"?><tv>';
    for (let c = 1; c <= channels; c++) yield `<channel id="c${c}.test"><display-name>Channel ${c}</display-name></channel>`;
    let k = 0;
    for (let c = 1; c <= channels; c++) {
      for (let i = 0; i < perChannel; i++) {
        const h = String(i % 24).padStart(2, '0');
        const title = opts.titlesPerChannel
          ? `Synthetic Title ${c}.${i % opts.titlesPerChannel}`
          : opts.uniqueTitles ? `Synthetic Title ${(k++ * 7919) % opts.uniqueTitles}` : `Programme ${i}`;
        yield `<programme start="20261013${h}0000 +0000" stop="20261013${h}3000 +0000" channel="c${c}.test"><title>${title}</title><desc>Synthetic description ${i}.</desc></programme>`;
      }
    }
    yield '</tv>';
  })());
}
