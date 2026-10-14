import { createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from 'solid-js';
import { resolveDrop } from '../logic/reorder.ts';
import { indexAt } from '../logic/virtual.ts';
import { createVirtualWindow } from './VirtualList.tsx';

/** Lists longer than this render only the rows near the viewport. */
export const VIRTUALIZE_ABOVE = 200;
/** Distance from a viewport edge (px) where a drag scrolls the page, and the fastest scroll step per frame. */
const EDGE_PX = 96;
const MAX_SCROLL_STEP = 18;

export interface RowContext<T> {
  item: Accessor<T>;
  index: Accessor<number>;
  /** The pointer drag handle (mouse and touch). Hidden from assistive tech: the move buttons do the same. */
  handle: () => JSX.Element;
  /** "Move up" / "Move down" buttons: drag-and-drop is never the only way. */
  moveButtons: () => JSX.Element;
  /** True while this row is being dragged. */
  dragging: Accessor<boolean>;
}

export interface SortableListProps<T> {
  items: readonly T[];
  key: (item: T) => string;
  /** Row pitch in px (the row is 8 px shorter: the gap). */
  itemHeight: number;
  /** Spoken name of an item, for the move buttons and announcements. */
  label: (item: T) => string;
  /** Rows before this index stay put, and nothing moves above them (Favourites stays first). */
  minIndex?: number;
  onMove: (from: number, to: number) => void;
  'aria-label': string;
  children: (ctx: RowContext<T>) => JSX.Element;
}

interface Drag {
  key: string;
  from: number;
  target: number;
  /** Pointer y in viewport coordinates, and where in the row it grabbed. */
  clientY: number;
  grab: number;
  pointerId: number;
}

/**
 * A reorderable list of fixed-height rows. Drag with the handle (pointer events, so mouse, pen and touch; the page
 * scrolls when the pointer nears the top or bottom edge), or use each row's Move up / Move down buttons (keyboard
 * and screen readers). A move is announced in a polite live region. Above VIRTUALIZE_ABOVE items only the rows near
 * the viewport are rendered; the dragged row always is.
 */
export function SortableList<T>(props: SortableListProps<T>) {
  let el: HTMLUListElement | undefined;
  const [drag, setDrag] = createSignal<Drag | undefined>();
  const [announce, setAnnounce] = createSignal('');
  const minIndex = () => props.minIndex ?? 0;
  const keys = createMemo(() => props.items.map((it) => props.key(it)));
  const indexOf = createMemo(() => {
    const m = new Map<string, number>();
    keys().forEach((k, i) => m.set(k, i));
    return m;
  });
  const range = createVirtualWindow({
    container: () => el,
    count: () => props.items.length,
    itemHeight: () => props.itemHeight,
    enabled: () => props.items.length > VIRTUALIZE_ABOVE,
  });
  const rendered = createMemo(() => {
    const r = range();
    const slice = keys().slice(r.start, r.end);
    const d = drag();
    if (d && !slice.includes(d.key) && indexOf().has(d.key)) slice.push(d.key);
    return slice;
  });

  /** Where the dragged row's top is, in px from the list top. */
  const dragTop = (d: Drag): number => {
    const top = el?.getBoundingClientRect().top ?? 0;
    const max = (props.items.length - 1) * props.itemHeight;
    return Math.min(Math.max(d.clientY - top - d.grab, minIndex() * props.itemHeight), Math.max(0, max));
  };

  /** The slot a row shows in while another row is dragged. */
  const slotOf = (i: number, d: Drag | undefined): number => {
    if (!d) return i;
    if (d.from < d.target && i > d.from && i <= d.target) return i - 1;
    if (d.from > d.target && i >= d.target && i < d.from) return i + 1;
    return i;
  };

  const retarget = (d: Drag): Drag => {
    const y = dragTop(d) + props.itemHeight / 2;
    return { ...d, target: Math.max(minIndex(), indexAt(y, props.itemHeight, props.items.length)) };
  };

  let scrollFrame = 0;
  const autoScroll = () => {
    scrollFrame = 0;
    const d = drag();
    if (!d) return;
    const h = window.innerHeight;
    let step = 0;
    if (d.clientY < EDGE_PX) step = -Math.ceil(((EDGE_PX - d.clientY) / EDGE_PX) * MAX_SCROLL_STEP);
    else if (d.clientY > h - EDGE_PX) step = Math.ceil(((d.clientY - (h - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_STEP);
    if (step !== 0) {
      window.scrollBy(0, step);
      setDrag(retarget(d));
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  };
  onCleanup(() => cancelAnimationFrame(scrollFrame));

  const startDrag = (e: PointerEvent, key: string) => {
    if (e.button !== 0 || !el) return;
    const from = indexOf().get(key);
    if (from === undefined || from < minIndex()) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const top = el.getBoundingClientRect().top;
    setDrag({ key, from, target: from, clientY: e.clientY, grab: e.clientY - top - from * props.itemHeight, pointerId: e.pointerId });
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
  };
  const moveDrag = (e: PointerEvent) => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    setDrag(retarget({ ...d, clientY: e.clientY }));
  };
  const endDrag = (e: PointerEvent, commit: boolean) => {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    setDrag(undefined);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (!commit) return;
    // The list may have changed during the drag: find the row by key now, and give up if it is gone.
    const drop = resolveDrop(keys(), d.key, d.target, minIndex());
    if (drop) move(drop.from, drop.to);
  };

  const move = (from: number, to: number) => {
    const item = props.items[from];
    if (item === undefined || to < minIndex() || to >= props.items.length || to === from) return;
    props.onMove(from, to);
    setAnnounce(`${props.label(item)} moved to position ${to + 1} of ${props.items.length}.`);
  };

  const moveBy = (key: string, delta: -1 | 1, btn: HTMLElement) => {
    const from = indexOf().get(key);
    if (from === undefined) return;
    move(from, from + delta);
    // Reordering the DOM can drop focus: put it back on this row's button (the other one at either end).
    const dir = delta < 0 ? 'up' : 'down';
    queueMicrotask(() => {
      const row = el?.querySelector<HTMLElement>(`[data-sort-key="${CSS.escape(key)}"]`);
      const same = row?.querySelector<HTMLButtonElement>(`[data-move="${dir}"]`);
      const other = row?.querySelector<HTMLButtonElement>(`[data-move="${dir === 'up' ? 'down' : 'up'}"]`);
      const target = same && !same.disabled ? same : other ?? btn;
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    });
  };

  return (
    <>
      <ul
        ref={el}
        class="sortable"
        classList={{ 'is-dragging': !!drag() }}
        aria-label={props['aria-label']}
        style={{ height: `${props.items.length * props.itemHeight}px` }}
      >
        <For each={rendered()}>
          {(key) => {
            const index = () => indexOf().get(key) ?? 0;
            const item = () => props.items[index()] as T;
            const dragging = () => drag()?.key === key;
            const y = () => {
              const d = drag();
              return d && d.key === key ? dragTop(d) : slotOf(index(), d) * props.itemHeight;
            };
            const locked = () => index() < minIndex();
            return (
              <li
                class="srow"
                classList={{ dragging: dragging() }}
                data-sort-key={key}
                style={{ transform: `translateY(${y()}px)`, height: `${props.itemHeight - 8}px` }}
              >
                {props.children({
                  item,
                  index,
                  dragging,
                  handle: () => (
                    <Show when={!locked()} fallback={<span class="drag-handle placeholder" aria-hidden="true" />}>
                      <span
                        class="drag-handle"
                        aria-hidden="true"
                        title="Drag to reorder"
                        onPointerDown={(e) => startDrag(e, key)}
                        onPointerMove={moveDrag}
                        onPointerUp={(e) => endDrag(e, true)}
                        onPointerCancel={(e) => endDrag(e, false)}
                      >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                          <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                          <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                          <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                        </svg>
                      </span>
                    </Show>
                  ),
                  moveButtons: () => (
                    <Show when={!locked()}>
                      <span class="move-buttons">
                        <button type="button" class="btn icon" data-move="up" aria-label={`Move ${props.label(item())} up`}
                          disabled={index() <= minIndex()} onClick={(e) => moveBy(key, -1, e.currentTarget)}>
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                        </button>
                        <button type="button" class="btn icon" data-move="down" aria-label={`Move ${props.label(item())} down`}
                          disabled={index() >= props.items.length - 1} onClick={(e) => moveBy(key, 1, e.currentTarget)}>
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                      </span>
                    </Show>
                  ),
                })}
              </li>
            );
          }}
        </For>
      </ul>
      <p class="sr-only" aria-live="polite">{announce()}</p>
    </>
  );
}
