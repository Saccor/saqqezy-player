/**
 * A view of whichever playback stack is primary (the slot with sound), so the app's single-view exports keep one
 * identity while multiview moves the sound between slots. Every read resolves on `current()` at that moment: methods
 * come back bound to their stack, accessors re-read it, and a reactive `current` makes Solid track the switch.
 */
export function createPrimaryFacade<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const stack = current();
      const v: unknown = Reflect.get(stack, key, stack);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(stack) : v;
    },
    has: (_target, key) => Reflect.get(current(), key) !== undefined,
    set(_target, key, value) {
      return Reflect.set(current(), key, value);
    },
  });
}
