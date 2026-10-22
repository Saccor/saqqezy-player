import { describe, expect, test } from 'vitest';
import { answerCount, backDecision, createRequestTokens, focusAfterSearch, searchRowLabel } from './pickerSearchLogic.ts';

describe('searchRowLabel', () => {
  test('empty query invites a search', () => {
    expect(searchRowLabel('', 0)).toEqual({ text: 'Search channels', muted: true });
    expect(searchRowLabel('   ', 0)).toEqual({ text: 'Search channels', muted: true });
  });
  test('query with a count', () => {
    expect(searchRowLabel('news', 12)).toEqual({ text: '"news" · 12 found', muted: false });
    expect(searchRowLabel('news', 1).text).toBe('"news" · 1 found');
    expect(searchRowLabel('zzz', 0).text).toBe('"zzz" · 0 found');
  });
  test('count unknown while the answer is pending', () => {
    expect(searchRowLabel('ne', undefined)).toEqual({ text: '"ne"', muted: false });
  });
});

describe('backDecision', () => {
  test('keyboard first, then the query, then the picker', () => {
    expect(backDecision({ keyboardOpen: true, query: 'a' })).toBe('closeKeyboard');
    expect(backDecision({ keyboardOpen: true, query: '' })).toBe('closeKeyboard');
    expect(backDecision({ keyboardOpen: false, query: 'a' })).toBe('clearQuery');
    expect(backDecision({ keyboardOpen: false, query: '' })).toBe('closePicker');
    expect(backDecision({ keyboardOpen: false, query: '  ' })).toBe('closePicker');
  });
});

describe('focusAfterSearch', () => {
  test('list only when there are results', () => {
    expect(focusAfterSearch(3)).toBe('list');
    expect(focusAfterSearch(0)).toBe('keyboard');
  });
});

describe('createRequestTokens', () => {
  test('only the latest request is current', () => {
    const t = createRequestTokens();
    const a = t.next();
    const b = t.next();
    expect(t.isLatest(a)).toBe(false);
    expect(t.isLatest(b)).toBe(true);
  });
  test('invalidate drops everything in flight', () => {
    const t = createRequestTokens();
    const a = t.next();
    t.invalidate();
    expect(t.isLatest(a)).toBe(false);
  });
});

describe('answerCount', () => {
  test('counts only for the query the answer belongs to', () => {
    expect(answerCount('news', { query: 'news', count: 12 })).toBe(12);
    expect(answerCount(' news ', { query: 'news', count: 12 })).toBe(12);
    expect(answerCount('newsx', { query: 'news', count: 12 })).toBeUndefined();
    expect(answerCount('news', undefined)).toBeUndefined();
  });
});
