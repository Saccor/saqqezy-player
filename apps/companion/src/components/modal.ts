/** Anything with the `inert` flag (an HTMLElement in the app; a plain object in tests). */
export interface InertTarget {
  inert: boolean;
}

/**
 * Traps focus in a modal dialog: everything behind it (the app shell) is made `inert` while it is open, so Tab,
 * screen-reader browse mode and clicks cannot reach it. The dialog itself must be rendered outside these elements
 * (a Portal). `inert` is supported by every current browser (Chrome/Edge 102, Safari 15.5, Firefox 112); where it is
 * missing the flag does nothing and the dialog still works, without the trap.
 * Returns the undo; elements that were inert already are left as they were. Calling the undo twice is harmless.
 */
export function inertWhileOpen(targets: Iterable<InertTarget | null | undefined>): () => void {
  const changed: InertTarget[] = [];
  for (const t of targets) {
    if (!t || t.inert) continue;
    t.inert = true;
    changed.push(t);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const t of changed) t.inert = false;
  };
}
