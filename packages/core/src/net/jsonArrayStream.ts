/** Elements per `JSON.parse` call: large enough to keep parse overhead low, small enough to stay cheap in memory. */
const JSON_BATCH = 1000;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0xfeff]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Parses a top-level JSON array from decoded text chunks without ever holding the whole text: elements are cut out
 * at depth 0 (string and escape state tracked across chunks) and parsed `batch` at a time. An answer that is not an
 * array (an error object, `null`) is small: it is buffered, parsed whole and yielded once with `nonArray`.
 * Malformed input (not JSON, an unterminated array, trailing text) throws `SyntaxError`; batches already yielded stay.
 */
export async function* jsonArrayBatches(
  text: AsyncIterable<string>,
  opts: { batch?: number } = {},
): AsyncGenerator<{ items: unknown[]; nonArray?: true }> {
  const batch = Math.max(1, opts.batch ?? JSON_BATCH);
  let phase: 'start' | 'array' | 'done' | 'whole' = 'start';
  let whole = '';
  /** Nesting inside the current element (0: between top-level elements). */
  let depth = 0;
  let inStr = false;
  let esc = false;
  /** Text of the current element carried over from earlier chunks. */
  let carry = '';
  let elements = 0;
  let pending: string[] = [];
  const bad = (why: string) => new SyntaxError(`Invalid JSON array: ${why}`);
  const flush = () => {
    const items = JSON.parse(`[${pending.join(',')}]`) as unknown[];
    pending = [];
    return { items };
  };

  for await (const chunk of text) {
    let i = 0;
    const n = chunk.length;
    if (phase === 'whole') {
      whole += chunk;
      continue;
    }
    if (phase === 'start') {
      while (i < n && WS.has(chunk.charCodeAt(i))) i++;
      if (i === n) continue;
      if (chunk.charCodeAt(i) !== 0x5b /* [ */) {
        phase = 'whole';
        whole = chunk.slice(i);
        continue;
      }
      phase = 'array';
      i++;
    }
    let start = i;
    for (; i < n; i++) {
      const c = chunk.charCodeAt(i);
      if (phase === 'done') {
        if (!WS.has(c)) throw bad('text after the array');
        continue;
      }
      if (inStr) {
        if (esc) esc = false;
        else if (c === BACKSLASH) esc = true;
        else if (c === QUOTE) inStr = false;
        continue;
      }
      if (c === QUOTE) inStr = true;
      else if (c === 0x7b /* { */ || c === 0x5b /* [ */) depth++;
      else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
        if (depth > 0) depth--;
        else if (c === 0x5d) {
          const el = (carry + chunk.slice(start, i)).trim();
          carry = '';
          if (el) pending.push(el);
          else if (elements > 0) throw bad('empty element');
          if (el) elements++;
          phase = 'done';
        } else throw bad('unbalanced brace');
      } else if (c === 0x2c /* , */ && depth === 0) {
        const el = (carry + chunk.slice(start, i)).trim();
        carry = '';
        if (!el) throw bad('empty element');
        pending.push(el);
        elements++;
        start = i + 1;
        if (pending.length >= batch) yield flush();
      }
    }
    if (phase === 'array') carry += chunk.slice(start);
    if (pending.length >= batch) yield flush();
  }

  if (phase === 'whole') {
    yield { items: [JSON.parse(whole) as unknown], nonArray: true };
    return;
  }
  if (phase === 'array') throw bad('unterminated array');
  if (pending.length) yield flush();
}
