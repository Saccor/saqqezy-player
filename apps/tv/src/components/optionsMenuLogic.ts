/** A row index kept inside a list of `length` rows (0 for an empty list): the list can shrink while a menu is open. */
export function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(length - 1, i));
}
