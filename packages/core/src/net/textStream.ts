import { SourceNetworkError } from '../errors.ts';

async function* readAll<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { completed = true; return; }
      yield value;
    }
  } finally {
    // Early exit (consumer break/throw): cancel so the upstream body is released.
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
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

// Gzip is decided by magic bytes only: a server may label an already-decoded body as gzip.
// `url` is kept for API compatibility and intentionally unused.
export async function* responseText(res: Response, _url: string): AsyncGenerator<string> {
  if (!res.body) throw new SourceNetworkError('The provider sent an empty response.');
  const reader = res.body.getReader();
  const first = await reader.read();
  if (first.done) return;
  let head = first.value;
  let ended = false;
  while (head.length < 2 && !ended) {
    const next = await reader.read();
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
  for await (const chunk of readAll(bytes)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
