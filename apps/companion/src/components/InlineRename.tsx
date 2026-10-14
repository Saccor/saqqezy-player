import { createSignal, onMount, Show } from 'solid-js';
import { NAME_MAX } from '@iptv/core';

export interface InlineRenameProps {
  /** Accessible name of the field, e.g. "New name for News". */
  label: string;
  initial: string;
  /** Shown as "Use original name" when the item has a rename (sends null). */
  canReset?: boolean;
  /** Empty names are not allowed unless `allowEmpty` (empty then means "reset"). */
  allowEmpty?: boolean;
  onSave: (name: string | null) => void;
  onCancel: () => void;
}

/** An inline name editor: Enter saves, Escape cancels. At most NAME_MAX characters (the reducer's limit). */
export function InlineRename(props: InlineRenameProps) {
  const [value, setValue] = createSignal(props.initial);
  let input: HTMLInputElement | undefined;
  onMount(() => {
    input?.focus();
    input?.select();
  });
  const trimmed = () => value().trim();
  const valid = () => trimmed().length <= NAME_MAX && (props.allowEmpty || trimmed().length > 0);
  const save = () => {
    if (!valid()) return;
    props.onSave(trimmed() === '' ? null : trimmed());
  };
  return (
    <form class="inline-rename" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input
        ref={input}
        type="text"
        aria-label={props.label}
        maxLength={NAME_MAX}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <button type="submit" class="btn primary small" disabled={!valid()}>Save</button>
      <Show when={props.canReset}>
        <button type="button" class="btn small" onClick={() => props.onSave(null)}>Original</button>
      </Show>
      <button type="button" class="btn small" onClick={() => props.onCancel()}>Cancel</button>
    </form>
  );
}
