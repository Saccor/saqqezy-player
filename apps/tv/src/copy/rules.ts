/** Copy rules (UI rethink spec 2026-10-26 §1.4). Pure: no Solid, no Lightning. */

export const MAX_LINE = 70;

export type CopyRuleId =
  | 'length' | 'playlist' | 'provider' | 'epg' | 'fromStart' | 'couldNot' | 'retry' | 'okKey' | 'arrowPath' | 'keyHint' | 'neutral';

export interface CopyEntry { path: string; text: string }
export interface CopyViolation { path: string; rule: CopyRuleId; text: string }

const RULES: readonly { id: Exclude<CopyRuleId, 'length'>; re: RegExp }[] = [
  { id: 'playlist', re: /\bplaylists?\b/i },
  { id: 'provider', re: /\bproviders?\b/i },
  { id: 'epg', re: /\bEPG\b/ },
  { id: 'fromStart', re: /\bFrom start\b/ },
  { id: 'couldNot', re: /\b[Cc]ould not\b/ },
  { id: 'retry', re: /\bRetry now\b|^Retry$/ },
  { id: 'okKey', re: /\bOk\b/ },
  { id: 'arrowPath', re: /→/ },
  { id: 'keyHint', re: /·\s*Back\s+\w+|\b(?:OK|Done|Right|Left|Menu|Yellow|Red|Green|Blue)\s*:\s|\(Left\/Right\)|\bPress OK\b|\bClick to\b/ },
  { id: 'neutral', re: /\b(?:free|premium|vip|cancel your|subscription|seller|reseller|sports? leagues?|ppv)\b/i },
];

/**
 * Named exceptions (spec §1.4 "Longer text needs a named exception in the copy test"), by copy path. Each entry says
 * why. Starts empty; Tasks 16–18 add exactly the entries they list, when the string they name exists (the copy test
 * fails on an exception that points at nothing).
 */
export const COPY_EXCEPTIONS: Readonly<Record<string, readonly CopyRuleId[]>> = {};

export function copyViolations(entries: readonly CopyEntry[], exceptions: Readonly<Record<string, readonly CopyRuleId[]>>): CopyViolation[] {
  const out: CopyViolation[] = [];
  for (const e of entries) {
    const allowed = exceptions[e.path] ?? [];
    if (e.text.length > MAX_LINE && !allowed.includes('length')) out.push({ path: e.path, rule: 'length', text: e.text });
    for (const r of RULES) if (r.re.test(e.text) && !allowed.includes(r.id)) out.push({ path: e.path, rule: r.id, text: e.text });
  }
  return out;
}

/** Sample argument for copy functions: a count and a name both read naturally as 88. */
const SAMPLE = 88;

/** Every string under `value`, and what each copy function returns for sample arguments, with dotted paths. */
export function collectCopy(value: unknown, path: string): CopyEntry[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (typeof value === 'function') {
    try {
      const r: unknown = (value as (...a: unknown[]) => unknown)(...Array.from({ length: value.length }, () => SAMPLE));
      return typeof r === 'string' ? [{ path, text: r }] : [];
    } catch {
      return [];
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => collectCopy(v, `${path}.${k}`));
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => collectCopy(v, `${path}.${i}`));
  return [];
}
