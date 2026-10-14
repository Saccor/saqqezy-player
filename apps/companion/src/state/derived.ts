import { createMemo, createRoot } from 'solid-js';
import { GroupModel } from '../logic/groups.ts';
import { channels } from './store.ts';

/**
 * Views derived from the channel list, built once per full state (not per layout change) and shared by the pages.
 * Module-level roots: they live as long as the page.
 */
export const groupModel = createRoot(() => createMemo(() => new GroupModel(channels())));
