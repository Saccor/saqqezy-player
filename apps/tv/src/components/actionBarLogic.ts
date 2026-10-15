/**
 * The selected button after the action list changed: the same action by id when it is still there (a list that grows
 * around it never moves the focus onto another button), else the previous index clamped to the list.
 */
export function selectedIndex(actions: readonly { id: string }[], id: string | undefined, prevIndex: number): number {
  if (actions.length === 0) return 0;
  const i = id === undefined ? -1 : actions.findIndex((a) => a.id === id);
  return i >= 0 ? i : Math.max(0, Math.min(prevIndex, actions.length - 1));
}
