export { APP_API_METHODS, AppApi, WrongSourceError, type AppApiDeps } from './appApi.ts';
export {
  CompanionHost, fitCompanionState, StateTooLargeError, validateSourceInput, type CompanionHostApi, type CompanionHostDeps,
  UNPAIRED_TTL_MS, PAIRED_TTL_MS, STATE_BUDGET_BYTES, LOGO_MAX_CHARS,
} from './companionHost.ts';
export { formatOf, type StreamFormat } from './streamFormat.ts';
export { expose, wrap, toRpcError, type PortLike, type Remote, type RpcError } from './rpc.ts';
export type {
  AppEvent, ChannelRow, CompanionControl, CompanionEndReason, CompanionStartResult, CompanionStatus, CompanionChannel, CompanionState, DiagnosticsInfo, InitState, LayoutOpsResult, LayoutOrigin,
  ListSummary, PlayableChannel, ProgrammeHit, ProgrammeLite, SearchResult, SourceCooldown, SourceSummary, TitleHit,
} from './types.ts';
