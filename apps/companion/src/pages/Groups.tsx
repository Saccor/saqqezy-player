import { createMemo, createSignal, Show } from 'solid-js';
import type { LayoutOp } from '@iptv/core';
import { sendAndSync } from '../components/controls.ts';
import { InlineRename } from '../components/InlineRename.tsx';
import { SortableList } from '../components/SortableList.tsx';
import { createNarrow } from '../components/VirtualList.tsx';
import { groupShowOps, providerGroups, type GroupView } from '../logic/groups.ts';
import { groupOrderOps } from '../logic/reorder.ts';
import { sendOps } from '../state/actions.ts';
import { groupModel } from '../state/derived.ts';
import { layout, store } from '../state/store.ts';
import { GroupDetailPage } from './GroupDetail.tsx';
import { focusLater } from './Lists.tsx';

/**
 * Groups: every provider group of the active source in the TV's order, with a "Show on TV" switch (hidden groups
 * disappear from the TV), an inline rename and the channel count. Drag (or Move up/down) to reorder: the TV gets
 * the full order (`setGroupOrder`). Open a group to sort, reorder, rename and hide its channels.
 */
export function GroupsPage() {
  const [open, setOpen] = createSignal<string | undefined>();
  return (
    <Show when={open()} keyed fallback={<GroupsOverview onOpen={setOpen} />}>
      {(id) => <GroupDetailPage groupId={id} onBack={() => { setOpen(undefined); focusLater(`open-group:${id}`); }} />}
    </Show>
  );
}

function GroupsOverview(props: { onOpen: (id: string) => void }) {
  const [renaming, setRenaming] = createSignal<string | undefined>();
  const narrow = createNarrow();
  const groups = createMemo((): GroupView[] => {
    const l = layout();
    return l ? providerGroups(groupModel(), l, store.state?.regions) : [];
  });
  const ids = () => groups().map((g) => g.id);

  return (
    <section class="page" aria-labelledby="groups-title">
      <div class="page-head">
        <h1 id="groups-title">Groups</h1>
      </div>
      <Show when={layout()} fallback={<Show when={store.stateStatus !== 'unanswered'}><p class="muted" role="status">Loading…</p></Show>}>
        <Show when={groups().length > 0} fallback={
          <div class="empty">
            <p>No groups yet.</p>
            <p class="muted">Groups come from your active source's playlist. Add or refresh a source first.</p>
          </div>
        }>
          <p class="muted">Drag to change the order on the TV. Hidden groups stay here so you can show them again.</p>
          <SortableList
            items={groups()}
            key={(g) => g.id}
            label={(g) => g.name}
            itemHeight={narrow() ? 124 : 76}
            aria-label="Groups"
            onMove={(from, to) => void sendOps(groupOrderOps(ids(), from, to))}
          >
            {(row) => {
              const g = () => row.item();
              return (
                <Show
                  when={renaming() !== g().id}
                  fallback={
                    <div class="srow-edit">
                      <InlineRename
                        label={`New name for ${g().name}`}
                        initial={g().name}
                        allowEmpty
                        canReset={g().name !== g().providerName}
                        onCancel={() => { setRenaming(undefined); focusLater(`rename-group:${g().id}`); }}
                        onSave={(n) => {
                          const id = g().id;
                          setRenaming(undefined);
                          const name = n === null || n === g().providerName ? null : n;
                          void sendOps([{ op: 'renameGroup', id, name }]);
                          focusLater(`rename-group:${id}`);
                        }}
                      />
                    </div>
                  }
                >
                  {row.handle()}
                  <div class="srow-main">
                    <span class="row-title one-line" classList={{ 'is-hidden': g().hidden || g().regionHidden }}>{g().name}</span>
                    <span class="row-sub one-line">
                      {g().count.toLocaleString('en-US')} {g().count === 1 ? 'channel' : 'channels'}
                      <Show when={g().name !== g().providerName}> · was “{g().providerName}”</Show>
                      <Show when={g().hidden}> · Hidden</Show>
                      <Show when={!g().hidden && g().regionHidden}> · Hidden by your countries</Show>
                    </span>
                  </div>
                  <div class="srow-move">{row.moveButtons()}</div>
                  <div class="srow-actions">
                    <label class="switch">
                      <input type="checkbox" role="switch" checked={!g().hidden && !g().regionHidden}
                        aria-label={`Show ${g().name} on TV`}
                        onChange={(e) => {
                          const el = e.currentTarget;
                          const ops: LayoutOp[] = groupShowOps(g(), el.checked, store.tvProtocol);
                          void sendAndSync(() => sendOps(ops), [el], () => !g().hidden && !g().regionHidden);
                        }} />
                      <span class="switch-track" aria-hidden="true" />
                      <span class="switch-text">Show</span>
                    </label>
                    <button type="button" class="btn small" data-focus={`rename-group:${g().id}`} onClick={() => setRenaming(g().id)}
                      aria-label={`Rename ${g().name}`}>Rename</button>
                    <button type="button" class="btn small" data-focus={`open-group:${g().id}`} onClick={() => props.onOpen(g().id)}
                      aria-label={`Open ${g().name}`}>Open</button>
                  </div>
                </Show>
              );
            }}
          </SortableList>
        </Show>
      </Show>
    </section>
  );
}
