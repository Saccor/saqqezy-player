import { createSignal, Show } from 'solid-js';
import { FAV_LIST_ID, MAX_LISTS, NAME_MAX, type UserList } from '@iptv/core';
import { InlineRename } from '../components/InlineRename.tsx';
import { SortableList } from '../components/SortableList.tsx';
import { createNarrow } from '../components/VirtualList.tsx';
import { listMoveOps, newListId } from '../logic/reorder.ts';
import { sendOps } from '../state/actions.ts';
import { layout, store } from '../state/store.ts';
import { ListDetailPage } from './ListDetail.tsx';

/** Focuses `[data-focus="<key>"]` once the DOM has updated. */
export function focusLater(key: string, fallback?: string): void {
  queueMicrotask(() => {
    const el = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)
      ?? (fallback ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(fallback)}"]`) : null);
    el?.focus();
  });
}

/**
 * My lists: Favourites first (it cannot be moved or deleted), then the user's lists. Create, rename inline,
 * delete with confirmation, reorder (drag or Move up/down), and open a list to edit its channels.
 */
export function ListsPage() {
  const [open, setOpen] = createSignal<string | undefined>();
  return (
    <Show when={open()} keyed fallback={<ListsOverview onOpen={setOpen} />}>
      {(id) => <ListDetailPage listId={id} onBack={() => { setOpen(undefined); focusLater(`open-list:${id}`, 'new-list'); }} />}
    </Show>
  );
}

function ListsOverview(props: { onOpen: (id: string) => void }) {
  const [name, setName] = createSignal('');
  const [renaming, setRenaming] = createSignal<string | undefined>();
  const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>();
  const narrow = createNarrow();
  const lists = () => layout()?.lists ?? [];
  const full = () => lists().length >= MAX_LISTS;

  const create = async (e: Event) => {
    e.preventDefault();
    const n = name().trim();
    if (!n || n.length > NAME_MAX || full()) return;
    setName('');
    await sendOps([{ op: 'createList', id: newListId(), name: n }]);
  };

  return (
    <section class="page" aria-labelledby="lists-title">
      <div class="page-head">
        <h1 id="lists-title">My lists</h1>
      </div>
      <Show when={layout()} fallback={<Show when={store.stateStatus !== 'unanswered'}><p class="muted" role="status">Loading…</p></Show>}>
        <form class="create-row" onSubmit={create}>
          <label class="sr-only" for="new-list">New list name</label>
          <input id="new-list" data-focus="new-list" type="text" placeholder="New list name" maxLength={NAME_MAX}
            value={name()} onInput={(e) => setName(e.currentTarget.value)} disabled={full()} />
          <button type="submit" class="btn primary" disabled={full() || name().trim() === ''}>Create list</button>
        </form>
        <Show when={full()}>
          <p class="hint">You have the most lists the TV supports ({MAX_LISTS}). Delete one to make another.</p>
        </Show>
        <SortableList
          items={lists()}
          key={(l) => l.id}
          label={(l) => l.name}
          itemHeight={narrow() ? 124 : 76}
          minIndex={1}
          aria-label="Lists"
          onMove={(from, to) => void sendOps(listMoveOps(lists(), from, to))}
        >
          {(row) => {
            const l = (): UserList => row.item();
            const fav = () => l().id === FAV_LIST_ID;
            return (
              <Show
                when={renaming() !== l().id}
                fallback={
                  <div class="srow-edit">
                    <InlineRename
                      label={`New name for ${l().name}`}
                      initial={l().name}
                      onCancel={() => { setRenaming(undefined); focusLater(`rename-list:${l().id}`); }}
                      onSave={(n) => {
                        const id = l().id;
                        setRenaming(undefined);
                        if (n !== null && n !== l().name) void sendOps([{ op: 'renameList', listId: id, name: n }]);
                        focusLater(`rename-list:${id}`);
                      }}
                    />
                  </div>
                }
              >
                <Show
                  when={confirmDelete() !== l().id}
                  fallback={
                    <div class="srow-edit confirm" role="group" aria-label={`Delete ${l().name}?`}>
                      <span class="one-line">Delete “{l().name}”?</span>
                      <button type="button" class="btn danger small" onClick={() => {
                        setConfirmDelete(undefined);
                        void sendOps([{ op: 'deleteList', listId: l().id }]);
                        focusLater('new-list');
                      }}>Delete</button>
                      <button type="button" class="btn small" ref={(b) => queueMicrotask(() => b.focus())}
                        onClick={() => { const id = l().id; setConfirmDelete(undefined); focusLater(`delete-list:${id}`); }}>
                        Cancel
                      </button>
                    </div>
                  }
                >
                  {row.handle()}
                  <div class="srow-main">
                    <span class="row-title one-line">{l().name}</span>
                    <span class="row-sub">
                      {l().channelIds.length.toLocaleString('en-US')} {l().channelIds.length === 1 ? 'channel' : 'channels'}
                      <Show when={fav()}><span class="badge subtle">Always first</span></Show>
                    </span>
                  </div>
                  <div class="srow-move">{row.moveButtons()}</div>
                  <div class="srow-actions">
                    <button type="button" class="btn small" data-focus={`open-list:${l().id}`} onClick={() => props.onOpen(l().id)}
                      aria-label={`Open ${l().name}`}>Open</button>
                    <button type="button" class="btn small" data-focus={`rename-list:${l().id}`} onClick={() => setRenaming(l().id)}
                      aria-label={`Rename ${l().name}`}>Rename</button>
                    <Show when={!fav()}>
                      <button type="button" class="btn small danger-text" data-focus={`delete-list:${l().id}`}
                        onClick={() => setConfirmDelete(l().id)} aria-label={`Delete ${l().name}`}>Delete</button>
                    </Show>
                  </div>
                </Show>
              </Show>
            );
          }}
        </SortableList>
      </Show>
    </section>
  );
}
