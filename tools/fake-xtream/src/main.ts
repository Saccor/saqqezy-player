import { startFakeXtream } from './server.ts';

const { url } = await startFakeXtream({
  port: Number(process.env.PORT ?? 8899), channels: Number(process.env.CHANNELS ?? 200), sports: process.env.SPORTS !== '0',
});
console.log(`Fake Xtream provider running at ${url}  (login: test / test)`);
console.log('Special usernames: expired, slow, error500. Video redirects to a licensed test stream.');
console.log('Refusal mode: GET /__control/refuse?on=1 answers 403 to everything (on=0 ends it; no query: the count).');
