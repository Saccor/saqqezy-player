import { SourceNetworkError } from '../errors.ts';

export interface BodyReadOptions {
  /** Abort when no chunk arrives for this long (ms). Off when undefined. */
  idleMs?: number;
  /** Cancels the read (the body is cancelled too). */
  signal?: AbortSignal;
}

const STALLED = 'The provider stopped sending data.';
const CANCELLED = 'The download was cancelled.';

/**
 * One `reader.read()` bounded by the inactivity timeout and the abort signal. On either, the reader is
 * cancelled (which releases the upstream body) and a `SourceNetworkError` is thrown.
 */
async function readChunk<T>(reader: ReadableStreamDefaultReader<T>, opts: BodyReadOptions): Promise<ReadableStreamReadResult<T>> {
  const { idleMs, signal } = opts;
  if (idleMs === undefined && !signal) return reader.read();
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw new SourceNetworkError(CANCELLED);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    if (idleMs !== undefined) timer = setTimeout(() => reject(new SourceNetworkError(STALLED)), idleMs);
    if (signal) {
      onAbort = () => reject(new SourceNetworkError(CANCELLED));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const read = reader.read();
  try {
    return await Promise.race([read, stop]);
  } catch (err) {
    read.catch(() => {});
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function* readAll<T>(stream: ReadableStream<T>, opts: BodyReadOptions): AsyncGenerator<T> {
  const reader = stream.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, opts);
      if (done) { completed = true; return; }
      yield value;
    }
  } finally {
    // Early exit (consumer break/throw, timeout): cancel so the upstream body is released.
    if (!completed) await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A read may still be pending on engines that reject releaseLock() then; the stream is cancelled anyway.
    }
  }
}

function prepend(first: Uint8Array, rest: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  let sentFirst = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(first);
        return;
      }
      const { done, value } = await rest.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return rest.cancel(reason);
    },
  });
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Decodes a playlist or XMLTV body to text chunks. Gzip is decided by magic bytes only: a server may label an
 * already-decoded body as gzip. `url` is kept for API compatibility and intentionally unused. With `idleMs`,
 * a body that sends nothing for that long fails with "The provider stopped sending data." (`SourceNetworkError`)
 * instead of hanging; `signal` cancels it.
 */
export async function* responseText(res: Response, _url: string, opts: BodyReadOptions = {}): AsyncGenerator<string> {
  if (!res.body) throw new SourceNetworkError('The provider sent an empty response.');
  const reader = res.body.getReader();
  const first = await readChunk(reader, opts);
  if (first.done) return;
  let head = first.value;
  let ended = false;
  while (head.length < 2 && !ended) {
    const next = await readChunk(reader, opts);
    if (next.done) ended = true;
    else head = concat(head, next.value);
  }
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  let bytes: ReadableStream<Uint8Array> = prepend(head, reader);
  if (gzip) {
    // DecompressionStream is Chromium 80+ (Tizen 6.5+): older TV engines get a clear error instead of a crash.
    if (typeof DecompressionStream !== 'function') {
      await reader.cancel().catch(() => {});
      throw new SourceNetworkError('This device cannot read compressed lists. Ask for an uncompressed link.');
    }
    bytes = bytes.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  }
  const text = new BodyDecoder(res.headers.get('content-type'));
  for await (const chunk of readAll(bytes, opts)) {
    const t = text.decode(chunk);
    if (t) yield t;
  }
  const tail = text.end();
  if (tail) yield tail;
}

const CHARSET_PARAM = /;\s*charset\s*=\s*["']?([^"';\s]+)/i;
const XML_ENCODING = /^\s*<\?xml\s[^>]*?encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
const NON_ASCII = /[^\0-\x7f]/;

/** A decoder for `label` (any WHATWG label), or undefined when the engine does not know it. */
function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label);
  } catch {
    return undefined;
  }
}

/** The bytes at the end of `b` that start a UTF-8 sequence it does not finish (at most 3). */
function openUtf8Tail(b: Uint8Array): Uint8Array {
  for (let k = 1; k <= 3 && k <= b.length; k++) {
    const c = b[b.length - k]!;
    if (c < 0x80) break;
    if (c >= 0xc0) return (c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2) > k ? b.subarray(b.length - k) : b.subarray(b.length);
  }
  return b.subarray(b.length);
}

/**
 * Bytes to text for a playlist or XMLTV body whose character set may be anything. A BOM decides at once. Otherwise
 * the body is read as strict UTF-8 until the first non-ASCII text: valid UTF-8 there commits to UTF-8 (also when the
 * server or XML declaration says Latin-1: a mislabelled UTF-8 body is the common case), while invalid UTF-8 switches
 * to the declared character set (Content-Type `charset`, else the XML declaration in the first chunk), else
 * windows-1252. Pure-ASCII text reads the same either way, so the choice can wait for the first byte that matters.
 * TextDecoder with `stream: true` instead of TextDecoderStream (Chromium 71+), so older TV engines work too.
 */
class BodyDecoder {
  private decoder: TextDecoder | undefined;
  /** Strict UTF-8 while undecided. */
  private strict: TextDecoder | undefined = new TextDecoder('utf-8', { fatal: true });
  private fallback = 'windows-1252';
  private first = true;
  /** The last bytes seen while undecided, for a UTF-8 sequence split across chunks. */
  private last: Uint8Array = new Uint8Array(0);

  constructor(private readonly contentType: string | null) {}

  decode(chunk: Uint8Array): string {
    if (this.first) {
      this.first = false;
      this.readFirst(chunk);
    }
    if (this.decoder) return this.decoder.decode(chunk, { stream: true });
    let text: string;
    try {
      text = this.strict!.decode(chunk, { stream: true });
    } catch {
      // Not strict UTF-8. Everything before was ASCII but the start of a sequence the previous chunk left open.
      return this.commit(concat(this.last, chunk));
    }
    this.last = openUtf8Tail(this.last.length ? concat(this.last, chunk) : chunk).slice();
    if (NON_ASCII.test(text)) {
      // Real UTF-8: committed, so a stray bad byte later is one U+FFFD, not a switch.
      this.strict = undefined;
      this.decoder = new TextDecoder();
      const open = this.last;
      this.last = new Uint8Array(0);
      return text + (open.length ? this.decoder.decode(open, { stream: true }) : '');
    }
    return text;
  }

  end(): string {
    if (this.decoder) return this.decoder.decode();
    try {
      return this.strict!.decode();
    } catch {
      // Ends inside an open sequence: those bytes were not UTF-8.
      return this.commit(this.last, true);
    }
  }

  /**
   * Picks the character set for `bytes`, the first ones that are not strict UTF-8: UTF-8 with a few stray bytes when
   * more of its non-ASCII text is valid than not (Latin-1 text is almost never valid UTF-8), else the fallback.
   */
  private commit(bytes: Uint8Array, final = false): string {
    this.strict = undefined;
    this.last = new Uint8Array(0);
    const utf8 = new TextDecoder();
    const text = utf8.decode(bytes, { stream: !final });
    let valid = 0;
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0xfffd) bad++;
      else if (c >= 0x80) valid++;
    }
    if (valid > bad) {
      this.decoder = utf8;
      return text;
    }
    this.decoder = decoderFor(this.fallback) ?? new TextDecoder('windows-1252');
    return this.decoder.decode(bytes, { stream: !final });
  }

  /** A BOM decides; a declared character set becomes the fallback (a UTF-16 one in Content-Type decides). */
  private readFirst(chunk: Uint8Array): void {
    if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
      this.decoder = new TextDecoder('utf-8');
      return;
    }
    if ((chunk[0] === 0xff && chunk[1] === 0xfe) || (chunk[0] === 0xfe && chunk[1] === 0xff)) {
      this.decoder = new TextDecoder(chunk[0] === 0xff ? 'utf-16le' : 'utf-16be');
      return;
    }
    const header = decoderFor(CHARSET_PARAM.exec(this.contentType ?? '')?.[1]);
    if (header?.encoding.startsWith('utf-16')) {
      this.decoder = header;
      return;
    }
    // The declaration is ASCII: windows-1252 reads it whatever the body is.
    const xml = XML_ENCODING.exec(new TextDecoder('windows-1252').decode(chunk.subarray(0, 256)));
    const declared = [header, decoderFor(xml?.[1])].find((d) => d && d.encoding !== 'utf-8' && !d.encoding.startsWith('utf-16'));
    if (declared) this.fallback = declared.encoding;
  }
}
