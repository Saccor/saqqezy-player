import { createMemo, Show } from 'solid-js';
import { canHideNoEpg } from '../logic/groups.ts';
import { sendOps } from '../state/actions.ts';
import { channels, layout, store } from '../state/store.ts';

/**
 * Display: "Hide channels without TV guide". It needs a guide: until the TV has one, every channel counts as having
 * guide data, so the switch is disabled (unless it is already on, so it can be turned off).
 */
export function DisplayPage() {
  const available = createMemo(() => (store.state ? canHideNoEpg({ coverageKnown: store.state.coverageKnown, channels: channels() }) : false));
  const withoutGuide = createMemo(() => {
    let n = 0;
    for (const c of channels()) if (!c.hasEpg) n++;
    return n;
  });
  const on = () => layout()?.hideNoEpg ?? false;

  return (
    <section class="page" aria-labelledby="display-title">
      <div class="page-head">
        <h1 id="display-title">Display</h1>
      </div>
      <Show when={layout()} fallback={<Show when={store.stateStatus !== 'unanswered'}><p class="muted" role="status">Loading…</p></Show>}>
        <div class="card setting">
          <label class="switch big">
            <input type="checkbox" role="switch" checked={on()} disabled={!available() && !on()}
              aria-describedby="hide-no-epg-hint"
              onChange={(e) => void sendOps([{ op: 'setHideNoEpg', value: e.currentTarget.checked }])} />
            <span class="switch-track" aria-hidden="true" />
            <span class="switch-label">Hide channels without TV guide</span>
          </label>
          <p class="hint" id="hide-no-epg-hint">
            <Show when={available()} fallback="Available once your TV has loaded a TV guide for the active source.">
              {withoutGuide() === 0
                ? 'Every channel has TV guide data.'
                : `${withoutGuide().toLocaleString('en-US')} ${withoutGuide() === 1 ? 'channel has' : 'channels have'} no TV guide data. Your lists always show every channel you added.`}
            </Show>
          </p>
        </div>
      </Show>
    </section>
  );
}
