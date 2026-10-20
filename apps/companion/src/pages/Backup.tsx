import { createSignal, For, onMount, Show } from 'solid-js';
import { backupDate, backupSize, canRestore, restoreCodeProblem, type StoredBackup } from '../logic/backups.ts';
import { runRequest } from '../state/actions.ts';
import { backups, deleteBackup, loadBackups } from '../state/backupStore.ts';
import { store } from '../state/store.ts';

/** Keeps password managers out of the recovery code field. */
const NO_AUTOFILL = {
  autocomplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

/**
 * Backup: the backups the TV sent to this phone (Settings › Storage › Back up to your phone on the TV), and
 * "Restore to this TV" with the recovery code the TV showed. The backups are encrypted; this page cannot read them.
 */
export function BackupPage() {
  const [open, setOpen] = createSignal<string | undefined>();
  onMount(() => { void loadBackups(); });
  const restorable = () => canRestore(store.tvProtocol);

  return (
    <section class="page" aria-labelledby="backup-title">
      <div class="page-head">
        <h1 id="backup-title">Backup</h1>
      </div>
      <div class="card form-card">
        <p class="no-margin">
          Your lists, hidden channels, renames, watch progress and a few preferences, saved from your TV. Sources and
          logins are not part of a backup: add the source on the TV first, and its lists come back with it.
        </p>
        <p class="hint">
          Backups are encrypted. Only the recovery code the TV showed when it made the backup can open one.
          To make a backup, open Settings › Storage › Back up to your phone on the TV.
        </p>
      </div>
      <Show when={!restorable()}>
        <p class="notice" role="status">Restoring needs a newer version of the app on this TV.</p>
      </Show>
      <Show when={backups().length} fallback={<p class="muted empty">No backups on this phone yet.</p>}>
        <ul class="list" aria-label="Backups on this phone">
          <For each={backups()}>
            {(b) => (
              <li class="row">
                <div class="row-main">
                  <span class="row-title">{b.tv}</span>
                  <span class="row-sub">{backupDate(b)} · {backupSize(b)}</span>
                </div>
                <div class="row-actions">
                  <button type="button" class="btn" disabled={!restorable()} aria-expanded={open() === b.id}
                    onClick={() => setOpen(open() === b.id ? undefined : b.id)}>
                    Restore to this TV
                  </button>
                  <button type="button" class="btn ghost" aria-label={`Delete the backup from ${b.tv}, ${backupDate(b)}`}
                    onClick={() => {
                      if (!window.confirm('Delete this backup from this phone?')) return;
                      if (open() === b.id) setOpen(undefined);
                      void deleteBackup(b.id);
                    }}>
                    Delete
                  </button>
                </div>
                <Show when={open() === b.id}>
                  <RestoreForm backup={b} onDone={() => setOpen(undefined)} />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function RestoreForm(props: { backup: StoredBackup; onDone: () => void }) {
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal(false);
  const id = `code-${props.backup.at}`;

  const submit = async (e: Event) => {
    e.preventDefault();
    const problem = restoreCodeProblem(code());
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    setBusy(true);
    const err = await runRequest({ t: 'restore', backup: props.backup.backup, code: code().trim() });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    // The code is not kept once it has done its job.
    setCode('');
    setDone(true);
  };

  return (
    <form class="form row-form" onSubmit={(e) => void submit(e)}>
      <Show when={!done()} fallback={
        <div class="form-actions">
          <p class="no-margin" role="status">Restored on the TV.</p>
          <button type="button" class="btn ghost" onClick={() => props.onDone()}>Close</button>
        </div>
      }>
        <p class="hint no-margin">On the TV, open Settings › Storage › Restore from your phone first. Then type the code here.</p>
        <div class="field">
          <label for={id}>Recovery code</label>
          <input id={id} class="code-input" value={code()} onInput={(e) => setCode(e.currentTarget.value)} {...NO_AUTOFILL}
            autocapitalize="characters" spellcheck={false} maxlength={64} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX"
            aria-describedby={error() ? `${id}-err` : undefined} aria-invalid={error() ? true : undefined} />
          <Show when={error()}>
            <p class="error" id={`${id}-err`} role="alert">{error()}</p>
          </Show>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn primary" disabled={busy()}>{busy() ? 'Restoring…' : 'Restore'}</button>
          <button type="button" class="btn ghost" onClick={() => props.onDone()} disabled={busy()}>Cancel</button>
        </div>
      </Show>
    </form>
  );
}
