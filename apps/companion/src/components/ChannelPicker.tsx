import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { CompanionChannel } from '@iptv/companion-protocol';
import { buildSearchKeys, filterChannels, type SearchKeys } from '../logic/picker.ts';
import { VirtualList } from './VirtualList.tsx';

const ROW_H = 60;

export interface ChannelPickerProps {
  /** Every channel of the active source. */
  channels: readonly CompanionChannel[];
  /** Search keys for `channels` (memoised by the caller, so reopening the picker is instant). */
  keys: SearchKeys;
  /** The channel's name as shown on the TV. */
  label: (c: CompanionChannel) => string;
  /** Channels already in the list: shown checked and disabled. */
  already: ReadonlySet<string>;
  listName: string;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}

/**
 * "Add channels": a dialog with a search over every channel (name, original name, group, number; case and
 * diacritics ignored), multi-select with checkboxes, and "Add N channels". The result list is virtualised, so
 * 50k channels stay smooth. Escape or Cancel closes it; focus returns to the opener (the caller's job).
 */
export function ChannelPicker(props: ChannelPickerProps) {
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  let scroller: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;

  const results = createMemo(() => {
    const idx = filterChannels(props.keys, query());
    return idx.map((i) => props.channels[i]!);
  });
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const selectShown = () => {
    const next = new Set(selected());
    for (const c of results()) if (!props.already.has(c.id)) next.add(c.id);
    setSelected(next);
  };
  const count = () => selected().size;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => {
    search?.focus();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
  });
  onCleanup(() => {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('modal-open');
  });

  return (
    <div class="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <div class="dialog-head">
          <h2 id="picker-title">Add channels to “{props.listName}”</h2>
          <label class="sr-only" for="picker-search">Search channels</label>
          <input
            id="picker-search"
            ref={search}
            type="search"
            placeholder="Search by name, group or number"
            autocomplete="off"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              if (scroller) scroller.scrollTop = 0;
            }}
          />
          <div class="picker-tools">
            <span class="muted" role="status" aria-live="polite">
              {results().length.toLocaleString('en-US')} {results().length === 1 ? 'channel' : 'channels'}
            </span>
            <span class="picker-tool-buttons">
              <button type="button" class="btn ghost small" onClick={selectShown} disabled={results().length === 0}>Select all shown</button>
              <Show when={count() > 0}>
                <button type="button" class="btn ghost small" onClick={() => setSelected(new Set<string>())}>Clear</button>
              </Show>
            </span>
          </div>
        </div>
        <div class="picker-scroll" ref={scroller}>
          <Show when={results().length > 0} fallback={<p class="muted empty-inline">No channels match.</p>}>
            <VirtualList items={results()} itemHeight={ROW_H} scroller={() => scroller} role="list" aria-label="Channels">
              {(c) => {
                const inList = () => props.already.has(c.id);
                const checked = () => inList() || selected().has(c.id);
                return (
                  <label class="pick-row" role="listitem" classList={{ disabled: inList() }}>
                    <input type="checkbox" checked={checked()} disabled={inList()}
                      onChange={(e) => toggle(c.id, e.currentTarget.checked)} />
                    <span class="pick-main">
                      <span class="row-title one-line">{props.label(c)}</span>
                      <span class="row-sub one-line">
                        {c.number} · {c.group}
                        <Show when={inList()}><span class="muted"> · In this list</span></Show>
                      </span>
                    </span>
                  </label>
                );
              }}
            </VirtualList>
          </Show>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" onClick={() => props.onClose()}>Cancel</button>
          <button type="button" class="btn primary" disabled={count() === 0} onClick={() => props.onAdd([...selected()])}>
            {count() === 0 ? 'Add channels' : `Add ${count().toLocaleString('en-US')} ${count() === 1 ? 'channel' : 'channels'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
