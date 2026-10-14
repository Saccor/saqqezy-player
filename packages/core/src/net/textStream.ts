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
  // TextDecoder with `stream: true` instead of TextDecoderStream (Chromium 71+), so older TV engines work too.
  const decoder = new TextDecoder();
  for await (const chunk of readAll(bytes, opts)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
