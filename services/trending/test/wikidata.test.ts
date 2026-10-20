import { describe, expect, test } from 'vitest';
import pageviewsTop from './fixtures/pageviews-top.json';
import wbgetentities from './fixtures/wbgetentities.json';
import {
  articleKey, candidateArticles, compactTop, isNamespaced, parseTmdbTrending, summarizeBatch, summarizeEntity,
} from '../src/wikidata.ts';

const FIXTURES: Record<string, unknown> = { 'pageviews-top.json': pageviewsTop, 'wbgetentities.json': wbgetentities };
// A deep copy per use, as a parsed answer would be.
const fixture = (name: string) => JSON.parse(JSON.stringify(FIXTURES[name])) as { entities: Record<string, unknown> };
const entities = fixture('wbgetentities.json').entities;

describe('summarizeEntity', () => {
  test('a film: ids, the earliest release, label in the language, English label, aliases deduplicated', () => {
    expect(summarizeEntity(entities.Q900001, 'sv')).toEqual({
      wd: 'Q900001', kind: 'movie', tmdb: 910001, imdb: 'tt9900001', year: 2025, date: Date.UTC(2025, 8, 2),
      titles: ['Syntetisk film', 'Synthetic Film', 'Syntetisk film: Del ett'],
    });
  });

  test('a subclass of film counts; a deprecated P31 is ignored; a year-precision date', () => {
    expect(summarizeEntity(entities.Q900002, 'sv')).toEqual({
      wd: 'Q900002', kind: 'movie', year: 2024, date: Date.UTC(2024, 0, 1), titles: ['Synthetic Cartoon'],
    });
  });

  test('a series: P4983, P580 start when there is no P577, "somevalue" snaks skipped', () => {
    expect(summarizeEntity(entities.Q900003, 'sv')).toEqual({
      wd: 'Q900003', kind: 'series', tmdb: 920003, year: 2019, date: Date.UTC(2019, 2, 1),
      titles: ['Syntetisk serie', 'Synthetic Series'],
    });
  });

  test('anything that is not a film or series is null', () => {
    expect(summarizeEntity(entities.Q900004, 'sv')).toBeNull();
    expect(summarizeEntity(entities['-1'], 'sv')).toBeNull();
    expect(summarizeEntity(undefined, 'sv')).toBeNull();
    expect(summarizeEntity({ id: 'Q1', claims: { P31: 'bad' } }, 'sv')).toBeNull();
  });
});

describe('summarizeBatch', () => {
  test('maps each asked article to its summary, or null when missing or not a title', () => {
    const asked = ['Syntetisk film (film, 2025)', 'Synthetic Cartoon', 'Syntetisk serie', 'Synthetic Person', 'Synthetic Missing'];
    const out = summarizeBatch(fixture('wbgetentities.json'), 'sv', asked);
    expect(Object.keys(out).sort()).toEqual([...asked].sort());
    expect(out['Syntetisk film (film, 2025)']?.wd).toBe('Q900001');
    expect(out['Syntetisk serie']?.kind).toBe('series');
    expect(out['Synthetic Person']).toBeNull();
    expect(out['Synthetic Missing']).toBeNull();
  });

  test('a malformed answer gives nothing (the articles are retried next run)', () => {
    expect(summarizeBatch({ error: { code: 'x' } }, 'sv', ['A'])).toEqual({});
  });
});

describe('pageviews', () => {
  test('compactTop keeps [article, views] pairs and drops junk', () => {
    expect(compactTop(fixture('pageviews-top.json'))).toEqual([
      ['Portal:Huvudsida', 100000], ['Special:Sök', 6000], ['Synthetic_Person', 5000],
      ['Syntetisk_film_(film,_2025)', 3000], ['Synthetic_Sequel:_Part_Two', 2500], ['Syntetisk_serie', 2000], ['-', 1500],
    ]);
    expect(compactTop({ items: 'x' })).toEqual([]);
  });

  test('isNamespaced: "Special:Search" yes, "Dune:_Part_Two" no', () => {
    expect(isNamespaced('Special:Sök')).toBe(true);
    expect(isNamespaced('Wikipedia:Hauptseite')).toBe(true);
    expect(isNamespaced('Synthetic_Sequel:_Part_Two')).toBe(false);
    expect(isNamespaced('Synthetic_Sequel: Part Two')).toBe(false);
    expect(isNamespaced('Plain')).toBe(false);
  });

  test('candidateArticles sums days, drops namespaces, main pages and "-", keeps the top n', () => {
    const day1: [string, number][] = [['Main_Page', 9e6], ['A_film', 100], ['B', 50], ['Special:Search', 1e5], ['-', 99]];
    const day2: [string, number][] = [['B', 80], ['C', 10]];
    expect(candidateArticles([day1, day2], 10)).toEqual([
      { article: 'B', views: 130 }, { article: 'A film', views: 100 }, { article: 'C', views: 10 },
    ]);
    expect(candidateArticles([day1, day2], 1)).toEqual([{ article: 'B', views: 130 }]);
  });

  test('articleKey uses spaces, as Wikidata sitelinks do', () => {
    expect(articleKey('Syntetisk_film_(film,_2025)')).toBe('Syntetisk film (film, 2025)');
  });
});

describe('parseTmdbTrending', () => {
  test('ids in order, junk skipped', () => {
    expect(parseTmdbTrending({ results: [{ id: 5 }, { id: 'x' }, { id: 7, title: 'Synthetic' }, null] })).toEqual([5, 7]);
    expect(parseTmdbTrending({})).toEqual([]);
  });
});
