export const LAZY_ONLY: readonly RegExp[];
export function forbiddenSources(sources: readonly string[], patterns?: readonly RegExp[]): string[];
export function mainChunkPath(distDir: string): string;
export function staticImports(code: string): string[];
export function startupChunks(distDir: string): string[];
export function checkMainChunk(distDir: string, patterns?: readonly RegExp[]): { chunk: string; bytes: number; forbidden: string[] };
export function checkStartup(distDir: string, patterns?: readonly RegExp[]): {
  chunk: string;
  bytes: number;
  totalBytes: number;
  chunks: { chunk: string; bytes: number }[];
  forbidden: { chunk: string; source: string }[];
};
export function isMainModule(argv1: string | undefined, metaUrl: string): boolean;
