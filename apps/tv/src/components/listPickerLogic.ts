import type { PickerRow } from '../screens/homeMenuLogic.ts';

export const DEFAULT_PICKER_HINT = 'Ok adds or removes · Back closes';

/**
 * The picker's footer lines. When any row has help, line 1 is the selected row's help (empty when it has none) and
 * line 2 the hint, so a row's help never hides the hint (an attribution, a busy note, the keys). Otherwise one line:
 * the hint. `more` ("▲ ▼") goes before the hint.
 */
export function pickerFooter(rows: readonly PickerRow[], selected: number, hint: string | undefined, more: string): string[] {
  const hintLine = more ? `${more} · ${hint ?? DEFAULT_PICKER_HINT}` : hint ?? DEFAULT_PICKER_HINT;
  if (!rows.some((r) => r.kind === 'list' && r.help)) return [hintLine];
  const r = rows[selected];
  return [(r?.kind === 'list' ? r.help : undefined) ?? '', hintLine];
}

/** Rows Up/Down and OK can land on: every row but a heading. */
export const pickerSelectable = (r: PickerRow | undefined): boolean => r !== undefined && r.kind !== 'heading';
