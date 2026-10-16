import { api } from '../api.ts';
import { initState } from './appState.ts';
import { createSourceLimit } from './sourceLimit.ts';

const limit = createSourceLimit((id) => api.getSource(id));

/** The active Xtream account's connection limit, when known (the failure text names it). */
export const activeMaxConnections = (): number | undefined => limit.of(initState()?.activeSourceId);

/** Re-reads the active source's limit (the shell calls this when the source changes and after a refusal). */
export const reloadSourceLimit = (): Promise<void> => limit.load(initState()?.activeSourceId);
