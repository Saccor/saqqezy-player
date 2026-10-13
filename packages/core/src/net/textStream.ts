import { SourceNetworkError } from '../errors.ts';

async function* readAll<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
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

export async function* responseText(res: Response, url: string): AsyncGenerator<string> {
  if (!res.body) throw new SourceNetworkError('The provider sent an empty response.');
  const reader = res.body.getReader();
  const first = await reader.read();
  if (first.done) return;
  const head = first.value;
  const type = res.headers.get('content-type') ?? '';
  let path = url;
  try { path = new URL(url).pathname; } catch { /* keep raw */ }
  const gzip = path.endsWith('.gz') || type.includes('gzip') || (head[0] === 0x1f && head[1] === 0x8b);
  let bytes: ReadableStream<Uint8Array> = prepend(head, reader);
  if (gzip) bytes = bytes.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  yield* readAll(bytes.pipeThrough(new TextDecoderStream()));
}
