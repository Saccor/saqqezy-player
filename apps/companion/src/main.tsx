import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { App } from './App.tsx';
import { takeFragmentFromWindow } from './connection/pair.ts';
import { onPageHide, onVisible } from './state/store.ts';
import './styles.css';

// First thing: read the QR pairing fragment and strip it from the address bar and history entry.
// The secrets then live only in memory (never in storage); a reload means pairing again.
const [fragment, setFragment] = createSignal(takeFragmentFromWindow(), { equals: false });
// A QR link opened in a tab that already shows this page only changes the fragment (no reload).
window.addEventListener('hashchange', () => {
  const next = takeFragmentFromWindow();
  if (next) setFragment(next);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onVisible();
});
window.addEventListener('pagehide', onPageHide);

const secure = window.isSecureContext && typeof crypto !== 'undefined' && crypto.subtle !== undefined;

render(() => <App fragment={fragment} secure={secure} />, document.getElementById('root')!);
