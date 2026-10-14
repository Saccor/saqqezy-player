import { createSignal, For, Show } from 'solid-js';
import type { CompanionSourceSummary, PhoneToTv } from '@iptv/companion-protocol';
import { progressText, runRequest } from '../state/actions.ts';
import { store } from '../state/store.ts';
import { SourceFormPanel } from './SourceForm.tsx';

type SourceAction = Extract<PhoneToTv, { t: 'deleteSource' | 'setActiveSource' | 'refresh' }>;

/**
 * Sources: the TV's sources with the active one marked; Set active, Edit, Delete (with confirmation) and
 * Refresh; Add source. Credentials are only fetched into the edit form, and dropped when it closes.
 */
export function SourcesPage() {
  const [form, setForm] = createSignal<{ mode: 'add' } | { mode: 'edit'; id: string } | undefined>();
  const [busy, setBusy] = createSignal<string | undefined>();
  const [error, setError] = createSignal<string | undefined>();
  const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>();
  const sources = () => store.state?.sources ?? [];

  const act = async (key: string, msg: SourceAction) => {
    if (busy()) return;
    setBusy(key);
    setError(undefined);
    const err = await runRequest(msg);
    setBusy(undefined);
    if (err) setError(err);
  };

  return (
    <section class="page" aria-labelledby="sources-title">
      <div class="page-head">
        <h1 id="sources-title">Sources</h1>
        <Show when={!form()}>
          <button type="button" class="btn primary" onClick={() => { setError(undefined); setForm({ mode: 'add' }); }}>
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
            onClose={() => setForm(undefined)}
          />
        )}
      </Show>

      <Show when={!form()}>
        <Show
          when={store.state}
          fallback={<p class="muted">Loading…</p>}
        >
          <Show
            when={sources().length > 0}
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
                  <li class="row" classList={{ active: s.active }}>
                    <div class="row-main">
                      <span class="row-title">{s.name}</span>
                      <span class="row-sub">
                        {s.kind === 'xtream' ? 'Xtream' : 'M3U playlist'}
                        <Show when={s.active}>
                          <span class="badge">Active</span>
                        </Show>
                      </span>
                    </div>
                    <Show
                      when={confirmDelete() === s.id}
                      fallback={
                        <div class="row-actions">
                          <Show when={!s.active}>
                            <button type="button" class="btn" disabled={!!busy()} onClick={() => act(`active:${s.id}`, { t: 'setActiveSource', id: s.id })}>
                              {busy() === `active:${s.id}` ? 'Switching…' : 'Set active'}
                            </button>
                          </Show>
                          <Show when={s.active}>
                            <button type="button" class="btn" disabled={!!busy()} onClick={() => act('refresh', { t: 'refresh', what: 'both' })}>
                              {busy() === 'refresh' ? 'Refreshing…' : 'Refresh'}
                            </button>
                          </Show>
                          <button type="button" class="btn" disabled={!!busy()} onClick={() => { setError(undefined); setForm({ mode: 'edit', id: s.id }); }}>
                            Edit
                          </button>
                          <button type="button" class="btn danger-text" disabled={!!busy()} onClick={() => setConfirmDelete(s.id)} aria-label={`Delete ${s.name}`}>
                            Delete
                          </button>
                        </div>
                      }
                    >
                      <div class="row-actions confirm" role="group" aria-label={`Delete ${s.name}?`}>
                        <span>Delete “{s.name}” from the TV?</span>
                        <button type="button" class="btn danger" disabled={!!busy()} onClick={async () => { await act(`delete:${s.id}`, { t: 'deleteSource', id: s.id }); setConfirmDelete(undefined); }}>
                          {busy() === `delete:${s.id}` ? 'Deleting…' : 'Delete'}
                        </button>
                        <button type="button" class="btn" disabled={!!busy()} onClick={() => setConfirmDelete(undefined)} ref={(el) => queueMicrotask(() => el.focus())}>
                          Cancel
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
