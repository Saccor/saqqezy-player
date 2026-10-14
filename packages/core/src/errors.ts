export class SourceAuthError extends Error {
  constructor(message = 'The provider rejected the login. Check your details.') {
    super(message);
    this.name = 'SourceAuthError';
  }
}

export class SourceNetworkError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SourceNetworkError';
  }
}

export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of ['username', 'password']) {
    if (u.searchParams.has(key)) u.searchParams.set(key, '***');
  }
  const parts = u.pathname.split('/');
  // Xtream stream paths: /live|movie|series/{user}/{pass}/{id}.{ext}
  if (parts.length >= 5 && ['live', 'movie', 'series'].includes(parts[1] ?? '')) {
    parts[2] = '***';
    parts[3] = '***';
  } else if (parts.length === 4 && parts[1] && parts[2] && /^\d+$/.test(parts[3] ?? '')) {
    // Xtream short form: /{user}/{pass}/{id}
    parts[1] = '***';
    parts[2] = '***';
  }
  const path = parts.join('/');
  const query = u.searchParams.toString().replace(/%2A/g, '*'); // not replaceAll: Chromium 85+ only
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}
