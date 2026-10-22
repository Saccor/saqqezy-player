import { createSignal, type Accessor } from 'solid-js';

/** What a window shows beyond its status: the source cut it, two windows kept cutting each other, or escalation. */
export interface WindowNote { kicked?: number; pingPong?: boolean; escalated?: boolean; deviceLimit?: boolean; at: number }

export interface WindowNotes {
  /** The notes by slot, read reactively. */
  notes: Accessor<ReadonlyMap<number, WindowNote>>;
  note(n: number, note: WindowNote): void;
  /** A window opens again (Retry, another channel): its note goes. */
  clear(n: number): void;
  /** The source just cut window `n`: its refusal that follows is the cut. */
  markDisplaced(n: number): void;
  /** True once after `markDisplaced(n)`. */
  takeDisplaced(n: number): boolean;
  /** Multiview leaves or enters: no note or cut mark of an earlier session survives (G9 decision C). */
  reset(): void;
}

export function createWindowNotes(): WindowNotes {
  const [notes, setNotes] = createSignal<ReadonlyMap<number, WindowNote>>(new Map());
  const displaced = new Set<number>();
  return {
    notes,
    note(n, note) { setNotes((m) => new Map(m).set(n, note)); },
    clear(n) {
      if (!notes().has(n)) return;
      setNotes((m) => {
        const next = new Map(m);
        next.delete(n);
        return next;
      });
    },
    markDisplaced(n) { displaced.add(n); },
    takeDisplaced: (n) => displaced.delete(n),
    reset() {
      displaced.clear();
      if (notes().size > 0) setNotes(new Map());
    },
  };
}
