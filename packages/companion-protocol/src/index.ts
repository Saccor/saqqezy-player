export { toB64Url, fromB64Url } from './b64.ts';
export {
  type PairingSecrets,
  PairingError,
  newQrSecrets,
  secretsFromQrFragment,
  newPairingCode,
  normalizeCode,
  secretsFromCode,
  SESSION_ID_BYTES,
  KEY_BYTES,
  CODE_LENGTH,
  PBKDF2_ITERATIONS,
} from './pairing.ts';
export {
  type Direction,
  type FrameHeader,
  type SealOptions,
  FrameError,
  sealMessage,
  openFrame,
  Reassembler,
  WIRE_VERSION,
  FLAG_COMPRESSED,
  FRAME_HEADER_BYTES,
  FRAME_IV_BYTES,
  GCM_TAG_BYTES,
  MAX_CHUNK_CIPHERTEXT,
  MAX_CHUNK_PLAINTEXT,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_IN_FLIGHT,
  INFLATE_SLICE_BYTES,
} from './frames.ts';
export { ReplayWindow } from './replay.ts';
export type { CompanionChannel, CompanionSourceSummary, CompanionState } from './state.ts';
export {
  type PhoneToTv, type TvToPhone, isPhoneToTv, isTvToPhone, isUnknownPhoneMessage, isUnknownTvMessage, MAX_FIELD_LEN,
  BACKUP_MESSAGE_MAX_CHARS, BACKUP_PROTOCOL, HEADERS_PROTOCOL, PHONE_TO_TV_TYPES, RECOVERY_INPUT_MAX, PING_INTERVAL_MS, PROTOCOL_VERSION, TV_TO_PHONE_TYPES, type TvHeaderSupport,
} from './messages.ts';
export {
  type FrameTransport,
  type RelayTransport,
  type CloseReason,
  type SecureChannelOptions,
  SecureChannel,
  ChannelClosedError,
  QueueFullError,
  MAX_DECRYPT_FAILURES,
} from './channel.ts';
export {
  type WebSocketLike,
  type WebSocketFactory,
  type WsTransportOptions,
  type TransportCloseReason,
  WebSocketRelayTransport,
  HEARTBEAT_MS,
  RECONNECT_GIVE_UP_MS,
  QUEUE_MAX_BYTES,
  PACE_MAX_FRAMES,
  PACE_WINDOW_MS,
} from './wsTransport.ts';
