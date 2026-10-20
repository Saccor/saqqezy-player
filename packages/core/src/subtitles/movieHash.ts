import type { FetchFn, StreamHeaders } from '../types.ts';

/** The OpenSubtitles hash reads this much from each end of the file. */
export const HASH_CHUNK = 65536;

const MASK = (BigInt(1) << BigInt(64)) - BigInt(1);

function sumWords(bytes: Uint8Array, start: bigint): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = start;
  for (let i = 0; i + 8 <= bytes.byteLength; i += 8) sum = (sum + view.getBigUint64(i, true)) & MASK;
  return sum;
}

/**
 * The OpenSubtitles "moviehash" of a file: its size plus every 64-bit little-endian word of its first and last
 * HASH_CHUNK bytes, mod 2^64, as 16 hex digits. It names one exact release, so subtitles matched by it are timed
 * for that file.
 */
export function openSubtitlesHash(size: number, head: Uint8Array, tail: Uint8Array): string {
  const sum = sumWords(tail, sumWords(head, BigInt(size) & MASK));
  return sum.toString(16).padStart(16, '0');
}

/** One byte range of `url`: the bytes and the file's total size, or undefined when the server did not honour it. */
async function range(
  fetchFn: FetchFn, url: string, from: number, to: number, headers: StreamHeaders | undefined,
): Promise<{ bytes: Uint8Array; size: number } | undefined> {
  const ac = new AbortController();
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Range: `bytes=${from}-${to}` }, signal: ac.signal, ...(headers ? { sourceHeaders: headers } : {}) });
  } catch {
    return undefined;
  }
  const total = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  if (res.status !== 206 || !total) {
    // A 200 is the whole film: stop it before any of it downloads.
    ac.abort();
    return undefined;
  }
  try {
    return { bytes: new Uint8Array(await res.arrayBuffer()), size: Number(total[1]) };
  } catch {
    return undefined;
  }
}

/**
 * The moviehash of a VOD file, read with two small range requests (the first also gives the size). Undefined, never
 * an error, for a playlist, a server that ignores ranges (aborted at once), a refusal or a file smaller than two
 * chunks: the search then simply goes without it. `headers`: the stream's User-Agent and Referer (some servers refuse
 * the file without them), passed as `FetchInit.sourceHeaders` with both requests.
 */
export async function fetchMovieHash(fetchFn: FetchFn, url: string, headers?: StreamHeaders): Promise<string | undefined> {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  // A playlist is not the film's file.
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return undefined;
  const head = await range(fetchFn, url, 0, HASH_CHUNK - 1, headers);
  if (!head || head.size < HASH_CHUNK * 2 || head.bytes.byteLength !== HASH_CHUNK) return undefined;
  const tail = await range(fetchFn, url, head.size - HASH_CHUNK, head.size - 1, headers);
  if (!tail || tail.bytes.byteLength !== HASH_CHUNK) return undefined;
  return openSubtitlesHash(head.size, head.bytes, tail.bytes);
}
