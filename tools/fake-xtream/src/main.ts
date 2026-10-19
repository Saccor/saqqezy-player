import { startFakeXtream } from './server.ts';

// FAKE_VOD_VERSIONS=1: every movie and series title is listed as three language and quality variants.
const versions = process.env.FAKE_VOD_VERSIONS === '1';
const { url } = await startFakeXtream({ port: Number(process.env.PORT ?? 8899), channels: Number(process.env.CHANNELS ?? 200), versions });
if (versions) console.log('Versions mode: each movie and series title is listed three times (language and quality variants).');
console.log(`Fake Xtream provider running at ${url}  (login: test / test)`);
console.log('Special usernames: expired, slow, error500. Video redirects to a licensed test stream.');
console.log('Refusal mode: GET /__control/refuse?on=1 answers 403 to everything (on=0 ends it; no query: the count).');
