const RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2})(\d{2}))?$/;

export function parseXmltvDate(s: string): number {
  const m = RE.exec(s.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, sec, sign, oh, om] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0));
  if (!sign) return utc;
  const offset = (Number(oh) * 60 + Number(om)) * 60_000;
  return sign === '+' ? utc - offset : utc + offset;
}
