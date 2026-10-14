import { createMemo, createSignal, Show } from 'solid-js';
import type { CompanionChannel } from '@iptv/companion-protocol';
import { ChannelPicker } from '../components/ChannelPicker.tsx';
import { SortableList } from '../components/SortableList.tsx';
import { createNarrow } from '../components/VirtualList.tsx';
import { channelLabel } from '../logic/groups.ts';
import { buildSearchKeys } from '../logic/picker.ts';
import { listChannelMoveOps } from '../logic/reorder.ts';
import { sendOps } from '../state/actions.ts';
import { groupModel } from '../state/derived.ts';
import { channels, layout } from '../state/store.ts';

/**
 * One list: its channels in the TV's order. Drag (or Move up/down) to reorder (`moveInList`), Remove
 * (`removeFromList`), and "Add channels" through the picker (`addToList`). Channels that are not in the active
 * source are listed as unavailable, so they can still be removed.
 */
export function ListDetailPage(props: { listId: string; onBack: () => void }) {
  const [picking, setPicking] = createSignal(false);
  const narrow = createNarrow();
  const list = createMemo(() => layout()?.lists.find((l) => l.id === props.listId));
  const ids = () => list()?.channelIds ?? [];
  const already = createMemo(() => new Set(ids()));
  const byId = () => groupModel().byId;
  const nameOf = (id: string): string => {
    const c = byId().get(id);
    return c ? channelLabel(c, layout()) : 'Unavailable channel';
  };
  // Built only while the picker is open; reopening after a change rebuilds it (cheap next to opening a dialog).
  const keys = createMemo(() => (picking() ? buildSearchKeys(channels(), (c) => channelLabel(c, layout())) : undefined));

  const closePicker = () => {
    setPicking(false);
    queueMicrotask(() => document.querySelector<HTMLElement>('[data-focus="add-channels"]')?.focus());
  };

  return (
    <section class="page" aria-labelledby="list-title">
      <button type="button" class="btn ghost back" onClick={() => props.onBack()}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        My lists
      </button>
      <Show when={list()} fallback={<p class="muted" role="status">This list no longer exists.</p>}>
        {(l) => (
          <>
            <div class="page-head">
              <div>
                <h1 id="list-title">{l().name}</h1>
                <p class="muted no-margin">{ids().length.toLocaleString('en-US')} {ids().length === 1 ? 'channel' : 'channels'}</p>
              </div>
              <button type="button" class="btn primary" data-focus="add-channels" onClick={() => setPicking(true)}
                disabled={channels().length === 0}>
                Add channels
              </button>
            </div>
            <Show when={ids().length > 0} fallback={
              <div class="empty">
                <p>This list is empty.</p>
                <p class="muted">Use Add channels to pick channels from your source.</p>
              </div>
            }>
              <SortableList
                items={ids()}
                key={(id) => id}
                label={nameOf}
                itemHeight={narrow() ? 116 : 72}
                aria-label={`Channels in ${l().name}`}
                onMove={(from, to) => void sendOps(listChannelMoveOps(props.listId, ids(), from, to))}
              >
                {(row) => {
                  const c = (): CompanionChannel | undefined => byId().get(row.item());
                  return (
                    <>
                      {row.handle()}
                      <div class="srow-main">
                        <span class="row-title one-line">{nameOf(row.item())}</span>
                        <span class="row-sub one-line">
                          <Show when={c()} fallback="Not in the current source">{(ch) => <>{ch().number} · {ch().group}</>}</Show>
                        </span>
                      </div>
                      <div class="srow-move">{row.moveButtons()}</div>
                      <div class="srow-actions">
                        <button type="button" class="btn small danger-text" aria-label={`Remove ${nameOf(row.item())} from ${l().name}`}
                          onClick={() => {
                            const index = row.index();
                            void sendOps([{ op: 'removeFromList', listId: props.listId, channelIds: [row.item()] }]);
                            // Focus the next row's Remove (or the previous one, or Add channels).
                            queueMicrotask(() => {
                              const rows = document.querySelectorAll<HTMLElement>('.sortable [data-remove]');
                              const next = [...rows].find((b) => Number(b.dataset['remove']) >= index) ?? rows[rows.length - 1];
                              (next ?? document.querySelector<HTMLElement>('[data-focus="add-channels"]'))?.focus();
                            });
                          }}
                          data-remove={row.index()}>
                          Remove
                        </button>
                      </div>
                    </>
                  );
                }}
              </SortableList>
            </Show>
            <Show when={picking() && keys()}>
              {(k) => (
                <ChannelPicker
                  channels={channels()}
                  keys={k()}
                  label={(c) => channelLabel(c, layout())}
                  already={already()}
                  listName={l().name}
                  onClose={closePicker}
                  onAdd={(add) => {
                    closePicker();
                    void sendOps([{ op: 'addToList', listId: props.listId, channelIds: add }]);
                  }}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
