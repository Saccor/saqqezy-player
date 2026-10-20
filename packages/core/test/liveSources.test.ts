import { describe, expect, test } from 'vitest';
import { orderLiveSources } from '../src/live/sources.ts';

const c = (id: string, quality: number, backup = false, bad = false) => ({ id, quality, backup, bad });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('orderLiveSources', () => {
  test('best quality first, spare feeds after, playlist order last', () => {
    expect(ids(orderLiveSources([c('hd', 2), c('sd', 3), c('uhd-b', 0, true), c('uhd', 0), c('hd2', 2)], {})))
      .toEqual(['uhd', 'uhd-b', 'hd', 'hd2', 'sd']);
  });
  test('the last played source first, then its quality', () => {
    expect(ids(orderLiveSources([c('uhd', 0), c('hd', 2), c('hd2', 2), c('sd', 3)], { last: 'hd2' })))
      .toEqual(['hd2', 'hd', 'uhd', 'sd']);
  });
  test('known-bad last, even when it was the last played', () => {
    expect(ids(orderLiveSources([c('uhd', 0, false, true), c('hd', 2)], { last: 'uhd' }))).toEqual(['hd', 'uhd']);
  });
  test('a last id that is not a candidate is ignored', () => {
    expect(ids(orderLiveSources([c('hd', 2), c('uhd', 0)], { last: 'gone' }))).toEqual(['uhd', 'hd']);
  });
  test('Your countries before quality; after known-bad and the last played source', () => {
    const p = (id: string, quality: number, bad = false) => ({ ...c(id, quality, false, bad), preferred: true });
    expect(ids(orderLiveSources([c('fhd', 1), p('hd', 2), p('sd', 3)], {}))).toEqual(['hd', 'sd', 'fhd']);
    expect(ids(orderLiveSources([c('fhd', 1), p('hd', 2)], { last: 'fhd' }))).toEqual(['fhd', 'hd']);
    expect(ids(orderLiveSources([c('fhd', 1), p('hd', 2, true)], {}))).toEqual(['fhd', 'hd']);
  });
});
