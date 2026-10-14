import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { CompanionSourceSummary, PhoneToTv } from '@iptv/companion-protocol';
import { COPY } from '../logic/copy.ts';
import { progressText, runRequest } from '../state/actions.ts';
import { store } from '../state/store.ts';
import { SourceFormPanel } from './SourceForm.tsx';

type SourceAction = Extract<PhoneToTv, { t: 'deleteSource' | 'setActiveSource' | 'refresh' }>;

/** Moves focus to the control marked `data-focus="<key>"` once the DOM has updated, else to Add source. */
function focusLater(key: string): void {
  queueMicrotask(() => {
    const el = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)
      ?? document.querySelector<HTMLElement>('[data-focus="add"]');
    el?.focus();
  });
}

/**
 * Sources: the TV's sources with the active one marked; Set active, Edit, Delete (with confirmation) and
 * Refresh; Add source. Credentials are only fetched into the edit form, and dropped when it closes.
 * Work on one source disables only that source's actions; it shows "Still working on the TV…" until its
 * result (or, after a stall, the next state) arrives. Focus returns to the control that opened a form or a
 * confirmation when it closes.
 */
export function SourcesPage() {
  const [form, setForm] = createSignal<{ mode: 'add' } | { mode: 'edit'; id: string } | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const sources = () => store.state?.sources ?? [];
  const work = (id: string) => store.working[id];

  const act = async (key: string, msg: SourceAction): Promise<string | undefined> => {
    if (work(key)) return undefined;
    setError(undefined);
    const err = await runRequest(msg, { key, attached: () => alive });
    if (err && alive) setError(err);
    return err;
  };

  const closeForm = () => {
    const f = form();
    setForm(undefined);
    focusLater(f?.mode === 'edit' ? `edit:${f.id}` : 'add');
  };

  const cancelDelete = (id: string) => {
    setConfirmDelete(undefined);
    focusLater(`delete:${id}`);
  };

  const confirmDeleteNow = async (id: string) => {
    const err = await act(id, { t: 'deleteSource', id });
    if (!alive) return;
    setConfirmDelete(undefined);
    // After a successful delete the row goes away with the next state: focus Add source instead.
    focusLater(err ? `delete:${id}` : 'add');
  };

  return (
    <section class="page" aria-labelledby="sources-title">
      <div class="page-head">
        <h1 id="sources-title">Sources</h1>
        <Show when={!form()}>
          <button type="button" class="btn primary" data-focus="add" disabled={!!work('add')}
            onClick={() => { setError(undefined); setForm({ mode: 'add' }); }}>
            Add source
          </button>
        </Show>
      </div>

      <Show when={store.progress}>
        {(p) => <p class="progress" role="status" aria-live="polite">{progressText(p())}</p>}
      </Show>
      <Show when={error()}>
        <p class="alert" role="alert">{error()}</p>
      </Show>

      <Show when={form()} keyed>
        {(f) => (
          <SourceFormPanel
            mode={f.mode}
            sourceId={f.mode === 'edit' ? f.id : undefined}
            onClose={closeForm}
          />
        )}
      </Show>

      <Show when={!form()}>
        <Show
          when={store.state}
          fallback={<Show when={store.stateStatus !== 'unanswered'}><p class="muted" role="status">Loading…</p></Show>}
        >
          <Show
            when={sources().length > 0 || work('add')}
            fallback={
              <div class="empty">
                <p>No sources on your TV yet.</p>
                <p class="muted">
                  Add the M3U playlist or Xtream login you already use: from your own media server, your operator, or a
                  free-to-air tuner.
                </p>
              </div>
            }
          >
            <ul class="list" aria-label="Sources">
              <For each={sources()}>
                {(s: CompanionSourceSummary) => (
                  <li class="row" classList={{ active: s.active }} aria-busy={!!work(s.id)}>
                    <div class="row-main">
                      <span class="row-title">{s.name}</span>
                      <span class="row-sub">
                        {s.kind === 'xtream' ? 'Xtream' : 'M3U playlist'}
                        <Show when={s.active}>
                          <span class="badge">Active</span>
                        </Show>
                      </span>
                      <Show when={work(s.id)}>
                        <span class="row-status" role="status">{COPY.rowWorking}</span>
                      </Show>
                    </div>
                    <Show
                      when={confirmDelete() === s.id}
                      fallback={
                        <div class="row-actions">
                          <Show when={!s.active}>
                            <button type="button" class="btn" disabled={!!work(s.id)} onClick={() => act(s.id, { t: 'setActiveSource', id: s.id })}>
                              {work(s.id)?.op === 'setActive' ? 'Switching…' : 'Set active'}
                            </button>
                          </Show>
                          <Show when={s.active}>
                            <button type="button" class="btn" disabled={!!work(s.id)} onClick={() => act(s.id, { t: 'refresh', what: 'both' })}>
                              {work(s.id)?.op === 'refresh' ? 'Refreshing…' : 'Refresh'}
                            </button>
                          </Show>
                          <button type="button" class="btn" data-focus={`edit:${s.id}`} disabled={!!work(s.id)}
                            onClick={() => { setError(undefined); setForm({ mode: 'edit', id: s.id }); }}>
                            Edit
                          </button>
                          <button type="button" class="btn danger-text" data-focus={`delete:${s.id}`} disabled={!!work(s.id)}
                            onClick={() => setConfirmDelete(s.id)} aria-label={`Delete ${s.name}`}>
                            Delete
                          </button>
                        </div>
                      }
                    >
                      <div class="row-actions confirm" role="group" aria-label={`Delete ${s.name}?`}>
                        <span>Delete “{s.name}” from the TV?</span>
                        <button type="button" class="btn danger" disabled={!!work(s.id)} onClick={() => confirmDeleteNow(s.id)}>
                          {work(s.id)?.op === 'delete' ? 'Deleting…' : 'Delete'}
                        </button>
                        <button type="button" class="btn" disabled={!!work(s.id)} onClick={() => cancelDelete(s.id)} ref={(el) => queueMicrotask(() => el.focus())}>
                          Cancel
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
              <Show when={work('add')}>
                <li class="row" aria-busy="true">
                  <div class="row-main">
                    <span class="row-title">New source</span>
                    <span class="row-status" role="status">{COPY.rowWorking}</span>
                  </div>
                </li>
              </Show>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
