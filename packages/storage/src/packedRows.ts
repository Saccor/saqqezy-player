/**
 * Lossless column codec for catalogue rows (channels, movies, series). A column per key; constant columns stored
 * once; string columns split into a shared prefix table + rest when few prefixes exist (URLs, `<source>:m123` ids);
 * object values (headers, catch-up) stored once per distinct value and shared again on unpack. Rows must be JSON-safe:
 * `undefined` properties are dropped, as IndexedDB and JSON drop them.
 */
export type Primitive = string | number | boolean | null;
export type PackedColumn =
  | { k: 'const'; value: Primitive; holes?: number[] }
  | { k: 'raw'; values: Primitive[]; holes?: number[] }
  | { k: 'prefix'; prefixes: string[]; idx: number[]; rest: string[]; holes?: number[] }
  | { k: 'obj'; table: string[]; idx: number[]; holes?: number[] };
export interface PackedRows { v: 1; n: number; keys: string[]; cols: PackedColumn[] }

const isPrimitive = (v: unknown): v is Primitive => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function splitAt(s: string): number {
  return Math.max(s.lastIndexOf('/'), s.lastIndexOf(':')) + 1;
}

/** Stores each value as JSON text in a table of distinct values; used for objects and for primitives mixed with objects. */
function objectColumn(values: unknown[], h: { holes?: number[] }): PackedColumn {
  const table = new Map<string, number>();
  const idx = values.map((v) => {
    const json = JSON.stringify(v);
    let i = table.get(json);
    if (i === undefined) { i = table.size; table.set(json, i); }
    return i;
  });
  return { k: 'obj', table: [...table.keys()], idx, ...h };
}

function packColumn(values: unknown[], holes: number[], n: number): PackedColumn {
  const h = holes.length > 0 ? { holes } : {};
  if (values.length > 0 && values.every(isPrimitive)) {
    const first = values[0] as Primitive;
    if (values.every((v) => v === first)) return { k: 'const', value: first, ...h };
    if (values.every((v) => typeof v === 'string')) {
      const strings = values as string[];
      const prefixes = new Map<string, number>();
      const limit = Math.max(16, Math.floor(n / 20));
      const idx: number[] = [];
      const rest: string[] = [];
      let usable = true;
      for (const s of strings) {
        const at = splitAt(s);
        const p = s.slice(0, at);
        let i = prefixes.get(p);
        if (i === undefined) {
          if (prefixes.size >= limit) { usable = false; break; }
          i = prefixes.size;
          prefixes.set(p, i);
        }
        idx.push(i);
        rest.push(s.slice(at));
      }
      if (usable && [...prefixes.keys()].some((p) => p.length > 0)) return { k: 'prefix', prefixes: [...prefixes.keys()], idx, rest, ...h };
    }
    return { k: 'raw', values: values as Primitive[], ...h };
  }
  return objectColumn(values, h);
}

export function packRows(rows: readonly object[]): PackedRows {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  const cols = keys.map((key) => {
    const values: unknown[] = [];
    const holes: number[] = [];
    rows.forEach((row, i) => {
      const v = (row as Record<string, unknown>)[key];
      if (v === undefined) holes.push(i); else values.push(v);
    });
    return packColumn(values, holes, rows.length);
  });
  return { v: 1, n: rows.length, keys, cols };
}

/**
 * Equal object values come back as one shared object, so callers must not mutate them in place.
 */
export function unpackRows(p: PackedRows): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = Array.from({ length: p.n }, () => ({}));
  p.keys.forEach((key, c) => {
    const col = p.cols[c]!;
    const holes = col.holes ?? [];
    let h = 0;
    let j = 0;
    const parsed = col.k === 'obj' ? col.table.map((json) => JSON.parse(json) as unknown) : undefined;
    // A plain assignment of '__proto__' would set the row's prototype; define it as an own property instead.
    const set = (row: Record<string, unknown>, value: unknown): void => {
      if (key === '__proto__') Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
      else row[key] = value;
    };
    for (let i = 0; i < p.n; i++) {
      if (h < holes.length && holes[h] === i) { h++; continue; }
      const row = out[i]!;
      switch (col.k) {
        case 'const': set(row, col.value); break;
        case 'raw': set(row, col.values[j]); break;
        case 'prefix': set(row, col.prefixes[col.idx[j]!]! + col.rest[j]!); break;
        case 'obj': set(row, parsed![col.idx[j]!]); break;
      }
      j++;
    }
  });
  return out;
}
