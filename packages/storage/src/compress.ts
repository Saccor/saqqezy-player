/**
 * Chunk codec: gzip through `CompressionStream` where the engine has it (Chromium 80+: Tizen 6.5+, webOS 6+), plain
 * UTF-8 otherwise (Tizen 6.0). The encoding is recorded per chunk, so any TV reads any chunk it can decode.
 */
export type ChunkEnc = 'gzip' | 'none';
export interface EncodedChunk { enc: ChunkEnc; bytes: ArrayBuffer }
export interface ChunkCodec { encode(text: string): Promise<EncodedChunk>; decode(chunk: EncodedChunk): Promise<string> }

type StreamCtor = new (format: 'gzip') => TransformStream<Uint8Array, Uint8Array>;

function exact(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export function createChunkCodec(g: { CompressionStream?: unknown; DecompressionStream?: unknown } = globalThis): ChunkCodec {
  const C = typeof g.CompressionStream === 'function' ? (g.CompressionStream as StreamCtor) : undefined;
  const D = typeof g.DecompressionStream === 'function' ? (g.DecompressionStream as StreamCtor) : undefined;
  return {
    async encode(text) {
      const u8 = new TextEncoder().encode(text);
      if (!C) return { enc: 'none', bytes: exact(u8) };
      try {
        const stream = new Blob([u8]).stream().pipeThrough(new C('gzip'));
        return { enc: 'gzip', bytes: await new Response(stream).arrayBuffer() };
      } catch {
        // The engine has the API but the pipeline fails: store plain rather than fail the write.
        return { enc: 'none', bytes: exact(u8) };
      }
    },
    async decode(chunk) {
      if (chunk.enc === 'none') return new TextDecoder().decode(chunk.bytes);
      if (!D) throw new Error('This TV cannot read a gzip chunk (no DecompressionStream)');
      const stream = new Blob([chunk.bytes]).stream().pipeThrough(new D('gzip'));
      return new Response(stream).text();
    },
  };
}
