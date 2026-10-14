import { openFrame, Reassembler, sealMessage, type Direction } from './frames.ts';
import type { PairingSecrets } from './pairing.ts';
import { ReplayWindow } from './replay.ts';

/** Any bidirectional carrier of opaque binary frames (a relay WebSocket, an in-memory pair in tests). */
export interface FrameTransport {
  send(frame: Uint8Array): void;
  onFrame(fn: (f: Uint8Array) => void): () => void;
  close(): void;
  /**
   * Lets the transport report that it closed by itself. The channel then closes with reason 'transport'.
   * Optional in the type so in-memory test transports can omit it, but the relay transports (TV and companion)
   * MUST implement it: without it a dead socket leaves the channel open and silent.
   * Fire it only when the transport is gone for good. To survive a dropped socket, keep the channel and hand
   * it a fresh transport with `SecureChannel.setTransport` before the old one reports close.
   */
  onClose?(fn: () => void): () => void;
}

export type CloseReason = 'decrypt-failures' | 'transport' | 'closed' | 'msgid-exhausted';

/** Consecutive bad frames or invalid messages before the channel closes. */
export const MAX_DECRYPT_FAILURES = 5;

const MAX_U32 = 0xffffffff;

export class ChannelClosedError extends Error {
  constructor() {
    super('channel closed');
    this.name = 'ChannelClosedError';
  }
}

export interface SecureChannelOptions<In> {
  secrets: PairingSecrets;
  role: 'tv' | 'phone';
  transport: FrameTransport;
  validate: (x: unknown) => x is In;
}

/**
 * End-to-end encrypted, typed message channel over any FrameTransport.
 *
 * - Outgoing messages get u32 msgIds that start at a random offset below 2^31 and increase by one per message.
 *   The counter never resets or wraps for the lifetime of the instance, including across transport reconnects:
 *   the peer's ReplayWindow rejects every msgId at or below its low-water mark, so a reset counter would have
 *   its messages dropped. If the counter would pass 2^32 - 1, the channel closes with reason 'msgid-exhausted'
 *   instead of wrapping; with at least 2^31 ids of headroom that never happens within a session.
 * - Reconnecting MUST reuse the same SecureChannel instance: call `setTransport(newTransport)`. Never build a
 *   new SecureChannel for the same pairing secrets on reconnect.
 * - Sends are serialised, so the frames of different messages never interleave on the wire.
 * - tv->phone messages are gzip-compressed when the TV has `CompressionStream`; phone->tv messages never are.
 * - Incoming frames are processed one at a time, in arrival order: decrypt, reassemble, then exactly once per
 *   completed message a replay check on its msgId, then `validate`. A frame that fails to decrypt or
 *   reassemble, a replayed message, and a message that fails validation each count as a failure and are dropped.
 *   MAX_DECRYPT_FAILURES consecutive failures close the channel with reason 'decrypt-failures'; an accepted
 *   message resets the count.
 */
export class SecureChannel<Out, In> {
  private readonly secrets: PairingSecrets;
  private transport: FrameTransport;
  private readonly validate: (x: unknown) => x is In;
  private readonly outDir: Direction;
  private readonly inDir: Direction;
  private readonly compress: boolean;
  private reassembler = new Reassembler();
  private readonly replay = new ReplayWindow();
  private readonly messageListeners = new Set<(msg: In, msgId: number) => void>();
  private readonly closeListeners = new Set<(reason: CloseReason) => void>();
  private unsubscribe: (() => void)[] = [];
  private nextMsgId: number;
  private sendChain: Promise<unknown> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private failures = 0;
  private closed = false;

  constructor(opts: SecureChannelOptions<In>) {
    this.secrets = opts.secrets;
    this.transport = opts.transport;
    this.validate = opts.validate;
    this.outDir = opts.role === 'tv' ? 'tv->phone' : 'phone->tv';
    this.inDir = opts.role === 'tv' ? 'phone->tv' : 'tv->phone';
    this.compress = opts.role === 'tv';
    // A random start below 2^31 leaves at least 2^31 ids before the counter would have to wrap.
    this.nextMsgId = crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1;
    this.attach(this.transport);
  }

  /**
   * Swaps in a new transport after a reconnect. The msgId counter and the replay window carry over, so the
   * peer keeps accepting our messages and frames replayed from the old connection stay rejected. Partial
   * incoming messages from the old transport are discarded. The old transport is detached, then closed.
   */
  setTransport(transport: FrameTransport): void {
    if (this.closed) throw new ChannelClosedError();
    const old = this.transport;
    this.detach();
    this.transport = transport;
    this.reassembler = new Reassembler();
    this.attach(transport);
    if (old !== transport) {
      try {
        old.close();
      } catch {
        // Already closed.
      }
    }
  }

  /** Encrypts and sends one message. Resolves with its msgId once every frame was handed to the transport. */
  send(msg: Out): Promise<number> {
    if (this.closed) return Promise.reject(new ChannelClosedError());
    if (this.nextMsgId > MAX_U32) {
      this.shutdown('msgid-exhausted', true);
      return Promise.reject(new ChannelClosedError());
    }
    const msgId = this.nextMsgId;
    this.nextMsgId++;
    const run = this.sendChain.then(async () => {
      if (this.closed) throw new ChannelClosedError();
      const frames = await sealMessage(
        this.secrets.key, this.secrets.sessionId, this.outDir, msgId, msg, { compress: this.compress },
      );
      for (const f of frames) {
        if (this.closed) throw new ChannelClosedError();
        try {
          this.transport.send(f);
        } catch (e) {
          this.shutdown('transport', true);
          throw e;
        }
      }
      return msgId;
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  onMessage(fn: (msg: In, msgId: number) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onClose(fn: (reason: CloseReason) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close(): void {
    this.shutdown('closed', true);
  }

  private attach(t: FrameTransport): void {
    this.unsubscribe.push(t.onFrame((f) => this.receive(f)));
    if (t.onClose) {
      this.unsubscribe.push(t.onClose(() => {
        if (this.transport === t) this.shutdown('transport', false);
      }));
    }
  }

  private detach(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  private receive(frame: Uint8Array): void {
    if (this.closed) return;
    this.recvChain = this.recvChain.then(() => this.process(frame));
  }

  private async process(frame: Uint8Array): Promise<void> {
    if (this.closed) return;
    let value: unknown;
    let msgId: number;
    try {
      const { header, plaintextChunk } = await openFrame(this.secrets.key, this.secrets.sessionId, this.inDir, frame);
      msgId = header.msgId;
      value = await this.reassembler.push(header, plaintextChunk);
    } catch {
      this.fail();
      return;
    }
    if (value === undefined || this.closed) return; // incomplete message
    if (!this.replay.accept(msgId) || !this.validate(value)) {
      this.fail();
      return;
    }
    this.failures = 0;
    for (const fn of [...this.messageListeners]) {
      try {
        fn(value, msgId);
      } catch {
        // A listener's error must not break the channel.
      }
    }
  }

  private fail(): void {
    this.failures++;
    if (this.failures >= MAX_DECRYPT_FAILURES) this.shutdown('decrypt-failures', true);
  }

  private shutdown(reason: CloseReason, closeTransport: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    if (closeTransport) {
      try {
        this.transport.close();
      } catch {
        // Already closed.
      }
    }
    this.messageListeners.clear();
    for (const fn of [...this.closeListeners]) {
      try {
        fn(reason);
      } catch {
        // Ignore listener errors.
      }
    }
    this.closeListeners.clear();
  }
}
