/** Is one of the user's followed teams a side of this match? Pure. */
import { jaroWinkler, normSide, resolveAlias } from './match.ts';

const FOLLOW_MATCH = 0.92;

export function isFollowed(sides: [string, string] | undefined, followed: readonly string[], aliases: ReadonlyMap<string, string>): boolean {
  if (!sides || followed.length === 0) return false;
  const ns = sides.map((s) => resolveAlias(normSide(s), aliases));
  return followed.some((f) => {
    const nf = resolveAlias(normSide(f), aliases);
    return nf !== '' && ns.some((s) => s === nf || jaroWinkler(s, nf) >= FOLLOW_MATCH);
  });
}
