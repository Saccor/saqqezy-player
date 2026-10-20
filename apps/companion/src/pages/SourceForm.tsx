import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createStore } from 'solid-js/store';
import { RequestError } from '../connection/pending.ts';
import { COPY } from '../logic/copy.ts';
import {
  cleanSource, emptyForm, FORM_LIMITS, formFromSource, formProblem, formToInput, formToSource, HEADER_UNUSED_NOTE, headerDimmed,
  headerHelp, headersAllowed, type SourceForm,
} from '../logic/source.ts';
import { currentClient, store } from '../state/store.ts';
import { progressText, runRequest } from '../state/actions.ts';

/**
 * Keeps password managers from offering to save or fill these fields: the credentials belong to the TV, and
 * `autocomplete="off"` alone is ignored by several of them.
 */
const NO_AUTOFILL = {
  autocomplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

/**
 * Add or edit a source. In edit mode the source (with its credentials) is fetched with `getSource` into this
 * form's memory only; on close the fields are wiped and the form dropped. Nothing is stored in the browser.
 * Cancel works while saving too: the form closes and the request keeps going on the TV (the Sources list shows
 * the source as still working until its result or the next state).
 */
export function SourceFormPanel(props: { mode: 'add' | 'edit'; sourceId: string | undefined; onClose: () => void }) {
  const [form, setForm] = createStore<SourceForm>(emptyForm('xtream'));
  const [loading, setLoading] = createSignal(props.mode === 'edit');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const [stalled, setStalled] = createSignal(false);
  const [showPassword, setShowPassword] = createSignal(false);
  // Fixed for the form's life: the TV this form talks to (a reconnect to another TV ends the session and the form).
  const withHeaders = headersAllowed(store.tvProtocol);
  /** Advanced starts open when the loaded source has a value; set once, so typing never collapses it. */
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  let firstField: HTMLInputElement | undefined;
  let alive = true;

  onMount(async () => {
    if (props.mode !== 'edit' || !props.sourceId) {
      firstField?.focus();
      return;
    }
    const c = currentClient();
    try {
      if (!c) throw new Error('no session');
      const src = await c.getSource(props.sourceId);
      if (!alive) return;
      // Unknown fields from a newer TV are dropped before anything can echo them back.
      const loaded = formFromSource(cleanSource(src, withHeaders));
      setForm(loaded);
      setAdvancedOpen(loaded.userAgent !== '' || loaded.referrer !== '');
    } catch (e) {
      if (!alive) return;
      setError(e instanceof RequestError && e.reason === 'timeout' ? COPY.timeout
        : e instanceof Error && e.name === 'NotFoundError' ? 'This source no longer exists on the TV.' : COPY.genericError);
    } finally {
      if (alive) {
        setLoading(false);
        queueMicrotask(() => firstField?.focus());
      }
    }
  });

  // Credentials stay in memory only while the form is open.
  onCleanup(() => {
    alive = false;
    setForm(emptyForm('xtream'));
  });

  const close = () => {
    setForm(emptyForm('xtream'));
    props.onClose();
  };

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (saving() || loading()) return;
    setError(undefined);
    setStalled(false);
    const f: SourceForm = { ...form };
    const problem = formProblem(f);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    const opts = { onStall: () => setStalled(true), attached: () => alive };
    const err = props.mode === 'edit' && props.sourceId
      ? await runRequest({ t: 'updateSource', source: formToSource(f, props.sourceId, withHeaders) }, { ...opts, key: props.sourceId })
      : await runRequest({ t: 'addSource', input: formToInput(f, withHeaders) }, { ...opts, key: 'add' });
    if (!alive) return;
    setSaving(false);
    setStalled(false);
    if (err) setError(err);
    else close();
  };

  const title = () => (props.mode === 'edit' ? 'Edit source' : 'Add source');

  return (
    <div class="card form-card">
      <h2>{title()}</h2>
      <Show when={!loading()} fallback={<p class="muted" role="status">Loading…</p>}>
        <form class="form" onSubmit={onSubmit} novalidate aria-busy={saving()}>
          <Show when={props.mode === 'add'}>
            <fieldset class="segmented">
              <legend>Type</legend>
              <label>
                <input type="radio" name="kind" value="xtream" checked={form.kind === 'xtream'} onChange={() => setForm('kind', 'xtream')} />
                <span>Xtream login</span>
              </label>
              <label>
                <input type="radio" name="kind" value="m3u" checked={form.kind === 'm3u'} onChange={() => setForm('kind', 'm3u')} />
                <span>M3U playlist</span>
              </label>
            </fieldset>
          </Show>

          <div class="field">
            <label for="src-name">Name <span class="optional">(optional)</span></label>
            <input id="src-name" ref={firstField} value={form.name} onInput={(e) => setForm('name', e.currentTarget.value)} {...NO_AUTOFILL} maxlength={FORM_LIMITS.name} />
          </div>

          <Show when={form.kind === 'xtream'}>
            <div class="field">
              <label for="src-server">Server address</label>
              <input id="src-server" type="url" inputmode="url" value={form.server} onInput={(e) => setForm('server', e.currentTarget.value)}
                placeholder="http://192.168.1.10:8080" {...NO_AUTOFILL} maxlength={FORM_LIMITS.url} autocapitalize="off" spellcheck={false} required />
            </div>
            <div class="field">
              <label for="src-user">Username</label>
              <input id="src-user" value={form.username} onInput={(e) => setForm('username', e.currentTarget.value)}
                {...NO_AUTOFILL} maxlength={FORM_LIMITS.credential} autocapitalize="off" spellcheck={false} required />
            </div>
            <div class="field">
              <label for="src-pass">Password</label>
              <div class="password">
                <input id="src-pass" type={showPassword() ? 'text' : 'password'} value={form.password}
                  onInput={(e) => setForm('password', e.currentTarget.value)} {...NO_AUTOFILL} maxlength={FORM_LIMITS.credential} autocapitalize="off" spellcheck={false} required />
                {/* A toggle: the name stays "Show password"; aria-pressed carries the state. */}
                <button type="button" class="btn ghost" aria-pressed={showPassword()} aria-label="Show password" aria-controls="src-pass"
                  onClick={() => setShowPassword((v) => !v)}>
                  Show
                </button>
              </div>
            </div>
          </Show>

          <Show when={form.kind === 'm3u'}>
            <div class="field">
              <label for="src-url">Playlist URL</label>
              <input id="src-url" type="url" inputmode="url" value={form.playlistUrl} onInput={(e) => setForm('playlistUrl', e.currentTarget.value)}
                placeholder="http://192.168.1.10/playlist.m3u" {...NO_AUTOFILL} maxlength={FORM_LIMITS.url} autocapitalize="off" spellcheck={false} required />
            </div>
            <div class="field">
              <label for="src-epg">TV guide URL <span class="optional">(optional)</span></label>
              <input id="src-epg" type="url" inputmode="url" value={form.epgUrl} onInput={(e) => setForm('epgUrl', e.currentTarget.value)}
                placeholder="http://192.168.1.10/guide.xml" {...NO_AUTOFILL} maxlength={FORM_LIMITS.url} autocapitalize="off" spellcheck={false} />
            </div>
          </Show>

          {/* Protocol 2 TVs only: older ones reject the fields. Collapsed; free text, no presets. */}
          <Show when={withHeaders}>
            <details class="advanced" open={advancedOpen()}>
              <summary>Advanced</summary>
              <div class="advanced-body">
                <p class="hint">{headerHelp(store.tvHeaders)}</p>
                <div class={headerDimmed(store.tvHeaders, 'userAgent') ? 'field dim' : 'field'}>
                  <label for="src-ua">User-Agent <span class="optional">(optional)</span></label>
                  <input id="src-ua" value={form.userAgent} onInput={(e) => setForm('userAgent', e.currentTarget.value)} placeholder="Default"
                    {...NO_AUTOFILL} maxlength={FORM_LIMITS.header} autocapitalize="off" spellcheck={false}
                    aria-describedby={headerDimmed(store.tvHeaders, 'userAgent') ? 'src-ua-note' : undefined} />
                  <Show when={headerDimmed(store.tvHeaders, 'userAgent')}>
                    <p id="src-ua-note" class="hint">{HEADER_UNUSED_NOTE}</p>
                  </Show>
                </div>
                <div class={headerDimmed(store.tvHeaders, 'referrer') ? 'field dim' : 'field'}>
                  <label for="src-ref">Referer <span class="optional">(optional)</span></label>
                  <input id="src-ref" value={form.referrer} onInput={(e) => setForm('referrer', e.currentTarget.value)} placeholder="Default"
                    {...NO_AUTOFILL} maxlength={FORM_LIMITS.header} autocapitalize="off" spellcheck={false}
                    aria-describedby={headerDimmed(store.tvHeaders, 'referrer') ? 'src-ref-note' : undefined} />
                  <Show when={headerDimmed(store.tvHeaders, 'referrer')}>
                    <p id="src-ref-note" class="hint">{HEADER_UNUSED_NOTE}</p>
                  </Show>
                </div>
              </div>
            </details>
          </Show>

          <p class="hint">Your details are sent encrypted to your TV and stored only there.</p>

          <Show when={saving() && store.progress}>
            {(p) => <p class="progress" role="status" aria-live="polite">{progressText(p())}</p>}
          </Show>
          <Show when={saving() && stalled()}>
            <p class="notice" role="status">{COPY.stillWorking}</p>
          </Show>
          <Show when={error()}>
            <p class="alert" role="alert">{error()}</p>
          </Show>

          <div class="form-actions">
            <button type="submit" class="btn primary" disabled={saving()}>
              {saving() ? 'Saving…' : props.mode === 'edit' ? 'Save' : 'Add source'}
            </button>
            <button type="button" class="btn" onClick={close}>Cancel</button>
          </div>
        </form>
      </Show>
    </div>
  );
}
