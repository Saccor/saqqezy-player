import { startFakeXtream } from './server.ts';

const { url } = await startFakeXtream({ port: Number(process.env.PORT ?? 8899), channels: Number(process.env.CHANNELS ?? 200) });
console.log(`Fake Xtream provider running at ${url}  (login: test / test)`);
console.log('Special usernames: expired, slow, error500. Video redirects to a licensed test stream.');
