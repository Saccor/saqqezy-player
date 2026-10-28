import type { LayoutOp } from '@iptv/core';
import { api } from '../api.ts';

/**
 * Applies channel layout ops (lists, hiding, renames). Resolves false, after calling `onFailed`, when the worker
 * refused any of them or the call failed; the reason is logged, never shown.
 */
export async function applyLayoutOps(ops: LayoutOp[], onFailed: () => void): Promise<boolean> {
  try {
    const res = await api.applyLayoutOps(ops);
    if (res.rejected.length === 0) return true;
    console.warn('Layout change refused', res.rejected.map((x) => x.reason).join(', '));
  } catch (err) {
    console.warn('Layout change failed', err instanceof Error ? err.name : 'Error');
  }
  onFailed();
  return false;
}
