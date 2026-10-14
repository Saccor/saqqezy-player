export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = '';
  let first = true;
  for await (const chunk of chunks) {
    buf += chunk;
    if (first && buf.length > 0) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      first = false;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  if (buf.length > 0) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}
