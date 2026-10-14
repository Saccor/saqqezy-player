/**
 * Encrypted message frames.
 *
 * A message is `JSON.stringify(value)` as UTF-8, optionally gzip-compressed as a whole (flag bit 0), then
 * split into chunks of at most MAX_CHUNK_PLAINTEXT bytes. Each chunk is encrypted separately with
 * AES-256-GCM under a fresh random 12-byte IV, so every chunk's ciphertext + tag is at most 256 KiB.
 *
 * Compression is directional:
 * - phone->tv frames are never compressed. Phone messages are small, and TV runtimes may lack
 *   `DecompressionStream`.
 * - tv->phone frames are compressed only when the sender asks for it (`compress: true`) and has
 *   `CompressionStream`. The phone is a modern browser and always has `DecompressionStream`.
 * A receiver without `DecompressionStream` still rejects a compressed frame; by design that never happens.
 *
 * Wire format of one frame (all integers big-endian):
 *
 *   offset  size  field
 *   0       1     version   (= 1)
 *   1       1     flags     (bit 0: compressed; all other bits must be 0)
 *   2       4     msgId     (u32)
 *   6       2     index     (u16, 0-based chunk index)
 *   8       2     count     (u16, number of chunks, >= 1)
 *   10      12    iv
 *   22      n     ciphertext || 16-byte GCM tag   (n <= 256 KiB)
 *
 * Additional authenticated data:
 *
 *   sessionId(16) || dir(1: 0 = tv->phone, 1 = phone->tv) || msgId(u32) || index(u16) || count(u16)
 *   || version(1) || flags(1)
 *
 * The first five fields are the Plan 4 AAD layout. version and flags are appended so every header
 * byte before the IV is authenticated (flipping the compressed bit must fail decryption).
 */

export type Direction = 'tv->phone' | 'phone->tv';

export interface FrameHeader {
  msgId: number;
  index: number;
  count: number;
  compressed: boolean;
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export const WIRE_VERSION = 1;
export const FLAG_COMPRESSED = 1;
export const FRAME_HEADER_BYTES = 10;
export const FRAME_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const MAX_CHUNK_CIPHERTEXT = 256 * 1024;
export const MAX_CHUNK_PLAINTEXT = MAX_CHUNK_CIPHERTEXT - GCM_TAG_BYTES;
/** Largest frame on the wire: header + IV + 256 KiB. Below the relay's 300 KiB limit. */
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + FRAME_IV_BYTES + MAX_CHUNK_CIPHERTEXT;
/** Limit for one message, both as JSON bytes and as the (possibly compressed) payload. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT = 4;
/** Compressed input is fed to the decompressor in slices of this size, so the output cap aborts early. */
export const INFLATE_SLICE_BYTES = 64 * 1024;

const SESSION_ID_BYTES = 16;
const MIN_FRAME_BYTES = FRAME_HEADER_BYTES + FRAME_IV_BYTES + GCM_TAG_BYTES;
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

function dirByte(dir: Direction): number {
  if (dir === 'tv->phone') return 0;
  if (dir === 'phone->tv') return 1;
  throw new FrameError('bad direction');
}

function isU32(n: number): boolean {
  return typeof n === 'number' && Math.floor(n) === n && n >= 0 && n <= MAX_U32;
}

function writeHeader(out: Uint8Array, flags: number, msgId: number, index: number, count: number): void {
  out[0] = WIRE_VERSION;
  out[1] = flags;
  out[2] = (msgId >>> 24) & 0xff;
  out[3] = (msgId >>> 16) & 0xff;
  out[4] = (msgId >>> 8) & 0xff;
  out[5] = msgId & 0xff;
  out[6] = (index >>> 8) & 0xff;
  out[7] = index & 0xff;
  out[8] = (count >>> 8) & 0xff;
  out[9] = count & 0xff;
}

/** AAD = sessionId || dir || header bytes [2..10) (msgId, index, count) || header bytes [0..2) (version, flags). */
function buildAad(sessionId: Uint8Array, dir: Direction, header: Uint8Array): Uint8Array {
  const aad = new Uint8Array(SESSION_ID_BYTES + 1 + 8 + 2);
  aad.set(sessionId, 0);
  aad[SESSION_ID_BYTES] = dirByte(dir);
  aad.set(header.subarray(2, FRAME_HEADER_BYTES), SESSION_ID_BYTES + 1);
  aad.set(header.subarray(0, 2), SESSION_ID_BYTES + 9);
  return aad;
}

function checkSessionId(sessionId: Uint8Array): void {
  if (!(sessionId instanceof Uint8Array) || sessionId.length !== SESSION_ID_BYTES) {
    throw new FrameError('bad sessionId');
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => undefined);
      throw new FrameError('message too large');
    }
    parts.push(value);
  }
  return concat(parts, total);
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function transform(
  data: Uint8Array, ts: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> }, limit: number,
): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  // Write errors surface through the readable side too; swallow them here to avoid unhandled rejections.
  writer.write(data).catch(() => undefined);
  writer.close().catch(() => undefined);
  return readAll(ts.readable, limit);
}

function canCompress(): boolean {
  return typeof CompressionStream !== 'undefined';
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return transform(data, new CompressionStream('gzip'), MAX_MESSAGE_BYTES + 1024);
}

/**
 * Inflates at most MAX_MESSAGE_BYTES. The input goes in INFLATE_SLICE_BYTES at a time, and each write waits
 * until the decompressor has taken the previous slice while the output is read concurrently. As soon as the
 * output passes the cap the read side cancels and no further input is fed, so a high-ratio bomb costs at
 * most a slice or two of inflation rather than the whole payload.
 */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new FrameError('compression not supported');
  let stop = false;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    writer = w;
    const feeding = (async () => {
      for (let off = 0; off < data.length && !stop; off += INFLATE_SLICE_BYTES) {
        await w.write(data.subarray(off, Math.min(data.length, off + INFLATE_SLICE_BYTES)));
      }
      if (!stop) await w.close();
    })();
    // Errors on the write side also surface on the read side; swallow them here to avoid unhandled rejections.
    feeding.catch(() => undefined);
    return await readAll(ds.readable, MAX_MESSAGE_BYTES);
  } catch (e) {
    if (e instanceof FrameError) throw e;
    throw new FrameError('bad compressed data');
  } finally {
    stop = true;
    writer?.abort().catch(() => undefined);
  }
}

export interface SealOptions {
  /**
   * Gzip the message when `CompressionStream` exists. Honoured for 'tv->phone' only; 'phone->tv' frames are
   * never compressed. Default false.
   */
  compress?: boolean;
}

/** Serialises, optionally compresses, chunks and encrypts one message. Returns the wire frames in order. */
export async function sealMessage(
  key: CryptoKey, sessionId: Uint8Array, dir: Direction, msgId: number, json: unknown, opts: SealOptions = {},
): Promise<Uint8Array[]> {
  checkSessionId(sessionId);
  dirByte(dir);
  if (!isU32(msgId)) throw new FrameError('bad msgId');
  const text = JSON.stringify(json) as string | undefined;
  if (typeof text !== 'string') throw new FrameError('value is not JSON-serialisable');
  let payload = new TextEncoder().encode(text);
  if (payload.length > MAX_MESSAGE_BYTES) throw new FrameError('message too large');

  let flags = 0;
  if (opts.compress === true && dir === 'tv->phone' && canCompress()) {
    payload = await gzip(payload);
    flags |= FLAG_COMPRESSED;
    if (payload.length > MAX_MESSAGE_BYTES) throw new FrameError('message too large');
  }

  const count = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PLAINTEXT));
  if (count > MAX_U16) throw new FrameError('message too large');
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * MAX_CHUNK_PLAINTEXT, Math.min(payload.length, (index + 1) * MAX_CHUNK_PLAINTEXT));
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    writeHeader(header, flags, msgId, index, count);
    const iv = crypto.getRandomValues(new Uint8Array(FRAME_IV_BYTES));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(sessionId, dir, header), tagLength: GCM_TAG_BYTES * 8 },
      key,
      chunk,
    ));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + FRAME_IV_BYTES + ct.length);
    frame.set(header, 0);
    frame.set(iv, FRAME_HEADER_BYTES);
    frame.set(ct, FRAME_HEADER_BYTES + FRAME_IV_BYTES);
    frames.push(frame);
  }
  return frames;
}

/** Parses and decrypts one wire frame. Throws FrameError on any malformed, tampered or misdirected frame. */
export async function openFrame(
  key: CryptoKey, sessionId: Uint8Array, dir: Direction, frame: Uint8Array,
): Promise<{ header: FrameHeader; plaintextChunk: Uint8Array }> {
  checkSessionId(sessionId);
  dirByte(dir); // a bad direction is a programming error, reported as such and not as a decryption failure
  if (!(frame instanceof Uint8Array) || frame.length < MIN_FRAME_BYTES || frame.length > MAX_FRAME_BYTES) {
    throw new FrameError('bad frame length');
  }
  if (frame[0] !== WIRE_VERSION) throw new FrameError('unsupported version');
  const flags = frame[1]!;
  if ((flags & ~FLAG_COMPRESSED) !== 0) throw new FrameError('unknown flags');
  // phone->tv frames are never compressed; reject before any decryption or inflate work.
  if ((flags & FLAG_COMPRESSED) !== 0 && dir === 'phone->tv') throw new FrameError('compressed phone frame');
  const msgId = ((frame[2]! << 24) | (frame[3]! << 16) | (frame[4]! << 8) | frame[5]!) >>> 0;
  const index = (frame[6]! << 8) | frame[7]!;
  const count = (frame[8]! << 8) | frame[9]!;
  if (count < 1 || index >= count) throw new FrameError('bad index');

  const header = frame.subarray(0, FRAME_HEADER_BYTES);
  const iv = frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + FRAME_IV_BYTES);
  const ct = frame.subarray(FRAME_HEADER_BYTES + FRAME_IV_BYTES);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(sessionId, dir, header), tagLength: GCM_TAG_BYTES * 8 },
      key,
      ct,
    );
  } catch {
    throw new FrameError('decryption failed');
  }
  return {
    header: { msgId, index, count, compressed: (flags & FLAG_COMPRESSED) !== 0 },
    plaintextChunk: new Uint8Array(plain),
  };
}

interface PendingMessage {
  count: number;
  compressed: boolean;
  chunks: (Uint8Array | undefined)[];
  received: number;
  bytes: number;
}

/**
 * Collects decrypted chunks per msgId and returns the parsed JSON once every chunk is in.
 * Memory is bounded: at most MAX_MESSAGE_BYTES per message (before and after decompression) and at most
 * MAX_IN_FLIGHT incomplete messages; when a new message would exceed that, the oldest partial one is dropped.
 * A rejected chunk drops its whole message.
 *
 * Replay protection is not done here. The caller must apply a ReplayWindow to the msgId of each completed
 * message, exactly once (never per frame, or multi-chunk messages would reject themselves). That window
 * relies on the sender's msgIds increasing monotonically for the lifetime of the pairing, without wrap or
 * reset across reconnects; SecureChannel guarantees both.
 */
export class Reassembler {
  private readonly pending = new Map<number, PendingMessage>();

  async push(h: FrameHeader, chunk: Uint8Array): Promise<unknown | undefined> {
    const { msgId, index, count, compressed } = h;
    if (!isU32(msgId) || !Number.isInteger(count) || count < 1 || count > MAX_U16
      || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new FrameError('bad header');
    }
    if ((count - 1) * MAX_CHUNK_PLAINTEXT >= MAX_MESSAGE_BYTES) throw new FrameError('message too large');
    if (chunk.length > MAX_CHUNK_PLAINTEXT) throw new FrameError('chunk too large');

    let p = this.pending.get(msgId);
    if (p === undefined) {
      if (count === 1) return this.finish([chunk], chunk.length, compressed);
      if (this.pending.size >= MAX_IN_FLIGHT) {
        const oldest = this.pending.keys().next();
        if (!oldest.done) this.pending.delete(oldest.value);
      }
      p = { count, compressed, chunks: new Array<Uint8Array | undefined>(count), received: 0, bytes: 0 };
      this.pending.set(msgId, p);
    } else if (p.count !== count || p.compressed !== compressed || p.chunks[index] !== undefined) {
      this.pending.delete(msgId);
      throw new FrameError('inconsistent or duplicate chunk');
    }

    p.bytes += chunk.length;
    if (p.bytes > MAX_MESSAGE_BYTES) {
      this.pending.delete(msgId);
      throw new FrameError('message too large');
    }
    p.chunks[index] = chunk;
    p.received++;
    if (p.received < p.count) return undefined;
    this.pending.delete(msgId);
    return this.finish(p.chunks as Uint8Array[], p.bytes, p.compressed);
  }

  private async finish(chunks: Uint8Array[], total: number, compressed: boolean): Promise<unknown> {
    let data = concat(chunks, total);
    if (compressed) data = await gunzip(data);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      throw new FrameError('bad utf-8');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new FrameError('bad json');
    }
  }
}
