import { createMemo, createSignal, For, Show } from 'solid-js';
import type { CompanionChannel } from '@iptv/companion-protocol';
import type { LayoutOp, SortMode } from '@iptv/core';
import { InlineRename } from '../components/InlineRename.tsx';
import { SortableList } from '../components/SortableList.tsx';
import { createNarrow } from '../components/VirtualList.tsx';
import { channelLabel, groupChannels, hasManualOrder, providerGroups, sortModeOf } from '../logic/groups.ts';
import { channelOrderOps } from '../logic/reorder.ts';
import { sendOps } from '../state/actions.ts';
import { groupModel } from '../state/derived.ts';
import { layout } from '../state/store.ts';
import { focusLater } from './Lists.tsx';

const SORTS: { mode: SortMode; label: string }[] = [
  { mode: 'provider', label: 'Provider' },
  { mode: 'number', label: 'Number' },
  { mode: 'name', label: 'A–Z' },
];

/**
 * One provider group: its channels (hidden ones included) in the TV's order. Sort by Provider / Number / A–Z
 * (`setSort`), drag or Move up/down for a custom order (`setChannelOrder` with the full order), "Reset to provider
 * order", and per-channel rename and hide.
 */
export function GroupDetailPage(props: { groupId: string; onBack: () => void }) {
  const [renaming, setRenaming] = createSignal<string | undefined>();
  const narrow = createNarrow();
  const group = createMemo(() => {
    const l = layout();
    return l ? providerGroups(groupModel(), l).find((g) => g.id === props.groupId) : undefined;
  });
  const list = createMemo((): CompanionChannel[] => {
    const l = layout();
    return l ? groupChannels(groupModel(), props.groupId, l) : [];
  });
  const hidden = createMemo(() => new Set(layout()?.hiddenChannels ?? []));
  const mode = () => (layout() ? sortModeOf(layout()!, props.groupId) : 'provider');
  const manual = () => (layout() ? hasManualOrder(layout()!, props.groupId) : false);
  const label = (c: CompanionChannel) => channelLabel(c, layout());

  const setMode = (m: SortMode) => {
    const ops: LayoutOp[] = [{ op: 'setSort', groupId: props.groupId, mode: m }];
    // A custom order comes before any sort; choosing a sort means "use this sort", so it replaces it.
    if (manual()) ops.push({ op: 'setChannelOrder', groupId: props.groupId, ids: null });
    void sendOps(ops);
  };
  const reset = () => {
    const ops: LayoutOp[] = [{ op: 'setChannelOrder', groupId: props.groupId, ids: null }];
    if (mode() !== 'provider') ops.push({ op: 'setSort', groupId: props.groupId, mode: 'provider' });
    void sendOps(ops);
  };

  return (
    <section class="page" aria-labelledby="group-title">
      <button type="button" class="btn ghost back" onClick={() => props.onBack()}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        Groups
      </button>
      <Show when={group()} fallback={<p class="muted" role="status">This group is not in the active source any more.</p>}>
        {(g) => (
          <>
            <div class="page-head">
              <div>
                <h1 id="group-title">{g().name}</h1>
                <p class="muted no-margin">
                  {g().count.toLocaleString('en-US')} {g().count === 1 ? 'channel' : 'channels'}
                  <Show when={g().hidden}> · Hidden on the TV</Show>
                </p>
              </div>
            </div>
            <fieldset class="segmented sort">
              <legend>Sort</legend>
              <For each={SORTS}>
                {(s) => (
                  <label>
                    <input type="radio" name="group-sort" value={s.mode} checked={!manual() && mode() === s.mode}
                      onChange={() => setMode(s.mode)} />
                    <span>{s.label}</span>
                  </label>
                )}
              </For>
            </fieldset>
            <div class="order-status">
              <span class="muted" role="status">
                {manual() ? 'Custom order. Drag or use the arrows to change it.' : 'Drag or use the arrows for a custom order.'}
              </span>
              <Show when={manual() || mode() !== 'provider'}>
                <button type="button" class="btn small" onClick={reset}>Reset to provider order</button>
              </Show>
            </div>
            <SortableList
              items={list()}
              key={(c) => c.id}
              label={label}
              itemHeight={narrow() ? 116 : 72}
              aria-label={`Channels in ${g().name}`}
              onMove={(from, to) => void sendOps(channelOrderOps(props.groupId, list().map((c) => c.id), from, to))}
            >
              {(row) => {
                const c = () => row.item();
                const isHidden = () => hidden().has(c().id);
                const renamed = () => label(c()) !== c().name;
                return (
                  <Show
                    when={renaming() !== c().id}
                    fallback={
                      <div class="srow-edit">
                        <InlineRename
                          label={`New name for ${label(c())}`}
                          initial={label(c())}
                          allowEmpty
                          canReset={renamed()}
                          onCancel={() => { setRenaming(undefined); focusLater(`rename-ch:${c().id}`); }}
                          onSave={(n) => {
                            const id = c().id;
                            setRenaming(undefined);
                            const name = n === null || n === c().name ? null : n;
                            void sendOps([{ op: 'renameChannel', id, name }]);
                            focusLater(`rename-ch:${id}`);
                          }}
                        />
                      </div>
                    }
                  >
                    {row.handle()}
                    <div class="srow-main">
                      <span class="row-title one-line" classList={{ 'is-hidden': isHidden() }}>{label(c())}</span>
                      <span class="row-sub one-line">
                        {c().number}
                        <Show when={renamed()}> · was “{c().name}”</Show>
                        <Show when={isHidden()}> · Hidden</Show>
                      </span>
                    </div>
                    <div class="srow-move">{row.moveButtons()}</div>
                    <div class="srow-actions">
                      <label class="switch">
                        <input type="checkbox" role="switch" checked={!isHidden()} aria-label={`Show ${label(c())} on TV`}
                          onChange={(e) => void sendOps([{ op: e.currentTarget.checked ? 'unhideChannels' : 'hideChannels', ids: [c().id] }])} />
                        <span class="switch-track" aria-hidden="true" />
                        <span class="switch-text">Show</span>
                      </label>
                      <button type="button" class="btn small" data-focus={`rename-ch:${c().id}`} onClick={() => setRenaming(c().id)}
                        aria-label={`Rename ${label(c())}`}>Rename</button>
                    </div>
                  </Show>
                );
              }}
            </SortableList>
          </>
        )}
      </Show>
    </section>
  );
}
