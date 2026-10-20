import { startFakeXtream } from './server.ts';

// FAKE_VOD_VERSIONS=1: every movie and series title is listed as three language and quality variants, and every
// channel as four streams (HD, FHD, 4K and a spare feed).
const versions = process.env.FAKE_VOD_VERSIONS === '1';
const { url } = await startFakeXtream({
  port: Number(process.env.PORT ?? 8899), channels: Number(process.env.CHANNELS ?? 200), versions, sports: process.env.SPORTS !== '0',
  catchup: process.env.CATCHUP !== '0',
  // FAKE_CATEGORY_ORDER=reverse: get_live_categories lists the groups last to first (provider order ≠ stream order).
  ...(process.env.FAKE_CATEGORY_ORDER === 'reverse' ? { categoryOrder: 'reverse' as const } : {}),
});
if (versions) console.log('Versions mode: each movie and series title is listed three times (language and quality variants); each channel four times.');
console.log(`Fake Xtream provider running at ${url}  (login: test / test)`);
console.log('Special usernames: expired, slow, error500. Video redirects to a licensed test stream.');
console.log('Catch-up: channels 1, 5, 9, … keep 7 days, 2, 6, 10, … 3 days (CATCHUP=0 turns it off); M3U with every mode: /catchup.m3u?username=test&password=test');
console.log('Refusal mode: GET /__control/refuse?on=1 answers 403 to everything (on=0 ends it; no query: the count).');
