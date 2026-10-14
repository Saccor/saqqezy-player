import { describe, expect, it } from 'vitest';
import { orderGroupChannels } from '../src/index.ts';

interface C { id: string; name: string; number: number }
const c = (id: string, name: string, number: number): C => ({ id, name, number });
const SRC: C[] = [c('a', 'Zeta', 3), c('b', 'alpha', 1), c('c', 'Beta 10', 2), c('d', 'Beta 9', 4)];
const ids = (xs: C[]) => xs.map((x) => x.id);
const nameOf = (x: C) => x.name;

describe('orderGroupChannels', () => {
  it('provider mode keeps the source order (and the same array when nothing changes)', () => {
    const out = orderGroupChannels(SRC, 'provider', undefined, nameOf);
    expect(out).toBe(SRC);
  });

  it('number mode sorts by number, or trusts a number-ordered source', () => {
    expect(ids(orderGroupChannels(SRC, 'number', undefined, nameOf))).toEqual(['b', 'c', 'a', 'd']);
    expect(orderGroupChannels(SRC, 'number', undefined, nameOf, true)).toBe(SRC);
  });

  it('name mode uses a case-insensitive, numeric collation of nameOf', () => {
    expect(ids(orderGroupChannels(SRC, 'name', undefined, nameOf))).toEqual(['b', 'd', 'c', 'a']);
    expect(ids(orderGroupChannels(SRC, 'name', undefined, (x) => (x.id === 'a' ? 'Aaa' : x.name)))).toEqual(['a', 'b', 'd', 'c']);
  });

  it('a manual order comes first (unknown and duplicate ids skipped), then the rest in sort order', () => {
    expect(ids(orderGroupChannels(SRC, 'number', ['d', 'x', 'a', 'd'], nameOf))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(orderGroupChannels(SRC, 'provider', [], nameOf))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(orderGroupChannels(SRC, 'provider', ['x'], nameOf))).toEqual(['a', 'b', 'c', 'd']);
  });
});
