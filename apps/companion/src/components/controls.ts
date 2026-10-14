/** A checkbox, switch or radio (an HTMLInputElement in the app; a plain object in tests). */
export interface Checkable {
  checked: boolean;
}

/**
 * Controlled switches and radios: the browser flips `checked` on click before the model changes. Runs `send` (e.g.
 * `sendOps`), then sets every control back to what the model says. So a change that was refused, returned early or
 * failed (and was reverted) never leaves a control showing a state the TV does not have. Radios: pass the whole group.
 */
export async function sendAndSync<T extends Checkable>(
  send: () => Promise<unknown>,
  controls: Iterable<T>,
  model: (control: T) => boolean,
): Promise<void> {
  try {
    await send();
  } finally {
    for (const c of controls) {
      const want = model(c);
      if (c.checked !== want) c.checked = want;
    }
  }
}
