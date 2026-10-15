import { LogoCache } from './logoCache.ts';

/** Failed poster and still URLs are remembered (a title card is drawn instead of retrying on every scroll). */
export const posterCache = new LogoCache(500);
