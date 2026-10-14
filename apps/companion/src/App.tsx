import { createEffect, createSignal, For, Match, on, Show, Switch, type Accessor, type JSX } from 'solid-js';
import { pairFromFragment } from './connection/pair.ts';
import { COPY } from './logic/copy.ts';
import { PairPage } from './pages/Pair.tsx';
import { SourcesPage } from './pages/Sources.tsx';
import { connect, store } from './state/store.ts';

type Tab = 'sources' | 'lists' | 'groups' | 'display';

const TABS: { id: Tab; label: string; icon: () => JSX.Element }[] = [
  { id: 'sources', label: 'Sources', icon: () => <path d="M4 6h16M4 12h16M4 18h10" /> },
  { id: 'lists', label: 'My lists', icon: () => <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z" /> },
  { id: 'groups', label: 'Groups', icon: () => <path d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z" /> },
  { id: 'display', label: 'Display', icon: () => <path d="M3 5h18v11H3zM8 20h8M12 16v4" /> },
];

export function App(props: { fragment: Accessor<string | null>; secure: boolean }) {
  const [pairError, setPairError] = createSignal<string | undefined>();
  const [qrPairing, setQrPairing] = createSignal(false);

  let seq = 0;
  createEffect(on(props.fragment, (fragment) => {
    if (!props.secure || !fragment) return;
    const mine = ++seq;
    setPairError(undefined);
    setQrPairing(true);
    pairFromFragment(fragment)
      .then((secrets) => {
        if (mine === seq) connect(secrets);
      })
      .catch(() => setPairError('This link is not valid. Show a new code on your TV, or type the code below.'))
      .finally(() => {
        if (mine === seq) setQrPairing(false);
      });
  }));

  return (
    <Switch>
      <Match when={!props.secure}>
        <main class="center-page">
          <div class="card narrow" role="alert">
            <h1>Secure connection needed</h1>
            <p>{COPY.insecure}</p>
          </div>
        </main>
      </Match>
      <Match when={qrPairing() || store.phase === 'connecting'}>
        <main class="center-page" aria-busy="true">
          <div class="card narrow">
            <div class="spinner" aria-hidden="true" />
            <h1>Connecting to your TV…</h1>
            <p class="muted">Keep the code on the TV screen until this page shows your sources.</p>
          </div>
        </main>
      </Match>
      <Match when={store.phase === 'pair' || store.phase === 'ended'}>
        <PairPage message={store.phase === 'ended' ? store.endMessage : pairError()} />
      </Match>
      <Match when={store.phase === 'connected'}>
        <Shell />
      </Match>
    </Switch>
  );
}

function Shell() {
  const [tab, setTab] = createSignal<Tab>('sources');
  const linkText = () => (store.link === 'online' ? 'Connected' : store.link === 'reconnecting' ? 'Reconnecting…' : 'Connecting…');

  return (
    <div class="shell">
      <header class="topbar">
        <span class={`dot ${store.link}`} aria-hidden="true" />
        <p class="topbar-title" role="status" aria-live="polite">
          <Show when={store.link === 'online'} fallback={linkText()}>
            Connected to <strong>{store.tvLabel ?? 'your TV'}</strong>
          </Show>
        </p>
      </header>
      <nav class="tabs" aria-label="Sections">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              class="tab"
              aria-current={tab() === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
                {t.icon()}
              </svg>
              <span>{t.label}</span>
            </button>
          )}
        </For>
      </nav>
      <main class="content" id="content">
        <Show when={store.notice}>
          <p class="notice" role="status">{store.notice}</p>
        </Show>
        <Switch>
          <Match when={tab() === 'sources'}>
            <SourcesPage />
          </Match>
          <Match when={tab() !== 'sources'}>
            <section class="page">
              <h1>{TABS.find((t) => t.id === tab())?.label}</h1>
              <p class="muted">This section is not available yet.</p>
            </section>
          </Match>
        </Switch>
      </main>
    </div>
  );
}
