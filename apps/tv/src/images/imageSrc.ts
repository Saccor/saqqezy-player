import { rawViaDevProxy } from '../net/devProxy.ts';
import { sizedSrc } from './sizedSrc.ts';

/** A source image (poster, logo, backdrop) drawn in a `w`×`h` box: loaded shrunk to that size (`images/sizedSrc.ts`). */
export function imageSrc(url: string, w: number, h: number): string {
  return sizedSrc(rawViaDevProxy(url), w, h);
}
