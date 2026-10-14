export { APP_API_METHODS, AppApi, WrongSourceError, type AppApiDeps } from './appApi.ts';
export {
  CompanionHost, fitCompanionState, StateTooLargeError, validateSourceInput, type CompanionHostApi, type CompanionHostDeps,
  UNPAIRED_TTL_MS, PAIRED_TTL_MS, STATE_BUDGET_BYTES, LOGO_MAX_CHARS,
} from './companionHost.ts';
export { expose, wrap, toRpcError, type PortLike, type Remote, type RpcError } from './rpc.ts';
export type {
  AppEvent, ChannelRow, CompanionControl, CompanionEndReason, CompanionStartResult, CompanionStatus, CompanionChannel, CompanionState, DiagnosticsInfo, InitState, LayoutOpsResult, LayoutOrigin,
  ListSummary, PlayableChannel, ProgrammeLite, SourceSummary,
} from './types.ts';
