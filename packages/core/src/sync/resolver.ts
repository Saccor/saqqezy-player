import type { SourceConfig } from '../types.ts';
import { fromSid, sourceFingerprint, toSid, type SyncRef } from './ref.ts';

export interface FingerprintedSource { sourceId: string; sfp: string }

/**
 * Maps between this device's stored ids and portable refs. A ref whose fingerprint matches no local source resolves to
 * nothing: its record stays pending (`PendingStore`) until such a source is added. Two local sources of one account
 * (same fingerprint) both receive its records.
 */
export class RefResolver {
  private readonly bySfp = new Map<string, string[]>();
  private readonly bySource = new Map<string, string>();

  constructor(sources: readonly FingerprintedSource[]) {
    for (const { sourceId, sfp } of sources) {
      this.bySource.set(sourceId, sfp);
      const list = this.bySfp.get(sfp);
      if (list) list.push(sourceId);
      else this.bySfp.set(sfp, [sourceId]);
    }
  }

  /** The fingerprint of a local source, if it has one. */
  sfpOf(sourceId: string): string | undefined {
    return this.bySource.get(sourceId);
  }

  /** Local sources that a ref's fingerprint names (empty: pending). */
  sourcesOf(sfp: string): string[] {
    return this.bySfp.get(sfp)?.slice() ?? [];
  }

  /** The ref of a stored id of `sourceId`; undefined for a source without a fingerprint. */
  ref(sourceId: string, localId: string, pk?: string): SyncRef | undefined {
    const sfp = this.bySource.get(sourceId);
    if (sfp === undefined) return undefined;
    const ref: SyncRef = { sfp, sid: toSid(sourceId, localId) };
    if (pk !== undefined) ref.pk = pk;
    return ref;
  }

  /** The stored id on `sourceId` of a source-scoped ref (channel, VOD item). */
  localId(sourceId: string, ref: SyncRef): string {
    return fromSid(sourceId, ref.sid);
  }
}

/** Fingerprints every source on the device (`K_fp` never leaves it) and builds the resolver. */
export async function buildResolver(kFp: CryptoKey, sources: readonly SourceConfig[]): Promise<RefResolver> {
  const out: FingerprintedSource[] = [];
  for (const s of sources) out.push({ sourceId: s.id, sfp: await sourceFingerprint(kFp, s) });
  return new RefResolver(out);
}

/** What `resolveVodTarget` needs to know about the local catalogue. */
export interface VodTargetView {
  has(itemId: string): boolean;
  /** The local item ids of a title group, first = the default version; undefined when the group is unknown here. */
  members(pk: string): readonly string[] | undefined;
  /** The user's version pick for a title group, if any. */
  pick(pk: string): string | undefined;
}

/**
 * Where a VOD record (progress, favourite, tracks) lands on `sourceId`. VOD state is keyed by title group with the
 * version secondary (§6.2): the exact version when it exists here, else the user's pick for the group, else the group's
 * first version. Undefined: neither is known yet, the record stays pending.
 */
export function resolveVodTarget(sourceId: string, ref: SyncRef, view: VodTargetView): string | undefined {
  const exact = fromSid(sourceId, ref.sid);
  if (view.has(exact)) return exact;
  if (ref.pk === undefined) return undefined;
  const picked = view.pick(ref.pk);
  if (picked !== undefined && view.has(picked)) return picked;
  const first = view.members(ref.pk)?.[0];
  return first !== undefined && view.has(first) ? first : undefined;
}
