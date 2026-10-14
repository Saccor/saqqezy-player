const FOLD: Record<string, string> = { ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', ß: 'ss', ẞ: 'ss', đ: 'd', Đ: 'd', ł: 'l', Ł: 'l' };

/**
 * Key for search matching (channel names and programme titles): accent- and case-insensitive, letters NFD does
 * not decompose folded, punctuation treated as spaces. Never contains "\n" (the title index uses it as a separator).
 * Not used for guide matching, which keeps `normalize()`.
 */
export function searchKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØæÆßẞđĐłŁ]/g, (c) => FOLD[c]!)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
