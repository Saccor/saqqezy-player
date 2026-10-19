/** A URL safe for the dev log: Xtream path credentials and every query value masked. */
export function maskUrl(u: URL): string {
  const parts = u.pathname.split('/');
  if (parts.length >= 5 && ['live', 'movie', 'series', 'timeshift'].includes(parts[1] ?? '')) {
    parts[2] = '***';
    parts[3] = '***';
  } else if (parts.length === 4 && /^\d+(?:\.\w+)?$/.test(parts[3] ?? '')) {
    parts[1] = '***';
    parts[2] = '***';
  }
  const query = [...u.searchParams.keys()].map((k) => `${k}=***`).join('&');
  return `${u.protocol}//${u.host}${parts.join('/')}${query ? `?${query}` : ''}`;
}
