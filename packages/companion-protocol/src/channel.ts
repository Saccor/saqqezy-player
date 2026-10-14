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

/**
 * The transport the relay clients (TV and companion) hand to a SecureChannel.
 *
 * Contract:
 * - It is long-lived and reconnects internally; the channel keeps using the same instance across drops.
 * - `onClose` fires only on a final give-up (no further reconnect attempts), never on a dropped socket.
 * - `send()` never throws while reconnecting. It queues up to 2 MiB or 60 s of frames; on overflow it gives
 *   up and fires `onClose`.
 * - `onReconnected` fires after each successful reconnect, so the app can resend its state.
 */
export interface RelayTransport extends FrameTransport {
  onClose(fn: (reason: string) => void): () => void;
  onReconnected(fn: () => void): () => void;
}

export type CloseReason = 'peer-errors' | 'transport' | 'closed' | 'msgid-exhausted';

/**
 * Consecutive failures before the channel closes. Before the first message is accepted every bad frame
 * counts (so a wrong key is detected during pairing). Afterwards only post-authentication problems count.
 */
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
 *   completed message a replay check on its msgId, then `validate`. Failure policy:
 *   - Until the first message is accepted, every bad frame (including GCM authentication failures) counts.
 *   - After that, frames that fail to open (authentication, framing, a compressed phone->tv frame) are dropped
 *     silently and never count, so an outsider injecting garbage on the relay cannot kill the session.
 *   - Post-authentication problems (replay, validation failure or throw, reassembly or gunzip error) always
 *     count.
 *   MAX_DECRYPT_FAILURES consecutive counted failures close the channel with reason 'peer-errors'; any
 *   accepted message resets the count.
 * - After `setTransport`, frames still in flight from the previous transport are dropped.
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
  private accepted = false;
  private generation = 0;
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
    this.generation++;
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
    const gen = this.generation;
    this.unsubscribe.push(t.onFrame((f) => this.receive(f, gen)));
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

  private receive(frame: Uint8Array, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    // process() never rejects, so the chain can never stay rejected and stall later frames.
    this.recvChain = this.recvChain.then(() => this.process(frame, gen)).catch(() => undefined);
  }

  private async process(frame: Uint8Array, gen: number): Promise<void> {
    if (this.closed || gen !== this.generation) return;
    try {
      const reassembler = this.reassembler;
      let opened: Awaited<ReturnType<typeof openFrame>>;
      try {
        opened = await openFrame(this.secrets.key, this.secrets.sessionId, this.inDir, frame);
      } catch {
        // Unauthenticated garbage. Counted only until the first message was accepted.
        if (!this.accepted) this.fail();
        return;
      }
      if (this.closed || gen !== this.generation) return;
      let value: unknown;
      try {
        value = await reassembler.push(opened.header, opened.plaintextChunk);
      } catch {
        this.fail();
        return;
      }
      if (value === undefined || this.closed || gen !== this.generation) return; // incomplete message
      const msgId = opened.header.msgId;
      if (!this.replay.accept(msgId) || !this.validate(value)) {
        this.fail();
        return;
      }
      this.accepted = true;
      this.failures = 0;
      for (const fn of [...this.messageListeners]) {
        try {
          fn(value, msgId);
        } catch {
          // A listener's error must not break the channel.
        }
      }
    } catch {
      this.fail(); // e.g. a throwing validator
    }
  }

  private fail(): void {
    this.failures++;
    if (this.failures >= MAX_DECRYPT_FAILURES) this.shutdown('peer-errors', true);
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
