import { describe, expect, test } from 'vitest';
import { isSportChannelName } from '../src/sports/words.ts';

// Guides that tag no sport category: a channel or folder named with a generic sport word is the sport signal instead.
// Synthetic names only; generic words only (never a broadcaster, league or club name).
describe('isSportChannelName', () => {
  test('a generic sport word in the name, as a word or joined to another word', () => {
    for (const name of [
      'XX: Synthetic Sport 1', 'XX| SPORTS', 'Synthetic Supersport HD', 'Northgate Sport UNO 4K', 'XX: SPORTV 2',
      'SE| FOTBOLL', 'Synthetic Foot', 'Lakeside Football Channel', 'Synthetic Fútbol', 'Synthetic Calcio',
      'Synthetic Soccer', 'Harbour Deportes', 'Synthetic League TV', 'Synthetic Liga', 'Synthetic Ligue 1',
    ]) expect(isSportChannelName(name), name).toBe(true);
  });

  test('ordinary names, and words that only happen to end in "sport", are not', () => {
    for (const name of ['Synthetic News', 'Passport Travel', 'Transport Today', 'Synthetic Kids', 'Footage Archive', 'Collegiate Hour', ''])
      expect(isSportChannelName(name), name).toBe(false);
  });
});
