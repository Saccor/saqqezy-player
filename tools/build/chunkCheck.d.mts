export const LAZY_ONLY: readonly RegExp[];
export function forbiddenSources(sources: readonly string[], patterns?: readonly RegExp[]): string[];
export function mainChunkPath(distDir: string): string;
export function checkMainChunk(distDir: string, patterns?: readonly RegExp[]): { chunk: string; bytes: number; forbidden: string[] };
