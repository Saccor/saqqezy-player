import { createSignal, Show } from 'solid-js';
import { formatCodeInput, isCodeComplete, pairFromCode } from '../connection/pair.ts';
import { COPY } from '../logic/copy.ts';
import { connect } from '../state/store.ts';

/**
 * Pairing by code: the 12-character code the TV shows (Settings → Phone and computer → code).
 * The input formats itself as XXXX-XXXX-XXXX. Connect runs one key derivation (≈ 0.2–1 s), then connects.
 * The code is kept only in this page's memory and cleared once the derivation finished.
 */
export function PairPage(props: { message: string | undefined }) {
  const [code, setCode] = createSignal('');
  const [deriving, setDeriving] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();
  const complete = () => isCodeComplete(code());

  const onInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    const el = e.currentTarget;
    const formatted = formatCodeInput(el.value);
    setCode(formatted);
    if (el.value !== formatted) el.value = formatted;
    setError(undefined);
  };

  const onSubmit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (deriving()) return;
    if (!complete()) {
      setError('Enter the 12-character code shown on your TV.');
      return;
    }
    setDeriving(true);
    try {
      const secrets = await pairFromCode(code());
      setCode('');
      try {
        connect(secrets);
      } catch {
        // Not a bad code: the session could not be started here (connect() is back in the pair phase).
        setError(COPY.genericError);
      }
    } catch {
      setError('Enter the 12-character code shown on your TV.');
    } finally {
      setDeriving(false);
    }
  };

  return (
    <main class="center-page">
      <div class="card narrow">
        <h1>Manage your TV</h1>
        <p class="muted">
          On your TV, open <strong>Settings → Phone and computer</strong>. Scan the QR code with your phone's
          camera, or type the code below.
        </p>
        <Show when={props.message}>
          <p class="alert" role="alert">{props.message}</p>
        </Show>
        <form class="form" onSubmit={onSubmit} novalidate>
          <div class="field">
            <label for="pair-code">Code</label>
            <input
              id="pair-code"
              class="code-input"
              name="code"
              inputmode="text"
              autocomplete="one-time-code"
              autocapitalize="characters"
              autocorrect="off"
              spellcheck={false}
              placeholder="XXXX-XXXX-XXXX"
              maxlength={14}
              value={code()}
              onInput={onInput}
              aria-invalid={error() ? 'true' : undefined}
              aria-describedby={error() ? 'pair-error' : 'pair-hint'}
              disabled={deriving()}
            />
            <Show when={error()} fallback={<p id="pair-hint" class="hint">Letters and numbers; the dashes are added for you.</p>}>
              <p id="pair-error" class="error">{error()}</p>
            </Show>
          </div>
          <button type="submit" class="btn primary wide" disabled={deriving()} aria-busy={deriving()}>
            {deriving() ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </main>
  );
}
