import { router as appRouter, type Router } from './router.ts';

/**
 * A screen's own Back layers by id (the Player's Options, stream info and sleep dialog; Multiview's menu and picker).
 * `open` registers a layer on top (replacing one with the same id, without its `onClose`); Back calls `onClose` once
 * the shell pops it. `remove` and `removeAll` take layers away without their `onClose` (the screen closes them itself,
 * or is going away).
 */
export function createLayerSet(router: Pick<Router, 'pushOverlay'> = appRouter) {
  const removers = new Map<string, () => void>();
  const remove = (id: string) => {
    const r = removers.get(id);
    removers.delete(id);
    r?.();
  };
  return {
    open: (id: string, onClose: () => void) => {
      removers.get(id)?.();
      removers.set(id, router.pushOverlay(id, () => { removers.delete(id); onClose(); }));
    },
    remove,
    removeAll: () => { for (const id of [...removers.keys()]) remove(id); },
  };
}
