import { createMemo, createSignal, For, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import { virtualWindow, type WindowRange } from '../logic/virtual.ts';

export interface WindowOptions {
  /** The element whose top is row 0. */
  container: () => HTMLElement | undefined;
  /** The scrolling element; the page (window) when omitted. */
  scroller?: () => HTMLElement | undefined;
  count: () => number;
  itemHeight: () => number;
  /** False: every row is rendered (small lists). */
  enabled?: () => boolean;
  overscan?: number;
}

/**
 * The rows of a fixed-height list to render, following scroll and resize (once per animation frame). Works with
 * the page scrolling or with a scrolling element.
 */
export function createVirtualWindow(opts: WindowOptions): Accessor<WindowRange> {
  const [tick, setTick] = createSignal(0);
  let frame = 0;
  const bump = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      setTick((n) => n + 1);
    });
  };
  onMount(() => {
    const target: HTMLElement | Window = opts.scroller?.() ?? window;
    target.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump, { passive: true });
    onCleanup(() => {
      target.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      cancelAnimationFrame(frame);
    });
    bump();
  });
  return createMemo(() => {
    tick();
    const count = opts.count();
    const itemHeight = opts.itemHeight();
    if (opts.enabled && !opts.enabled()) return { start: 0, end: count, totalHeight: count * itemHeight };
    const el = opts.container();
    if (!el) return { start: 0, end: Math.min(count, 30), totalHeight: count * itemHeight };
    const top = el.getBoundingClientRect().top;
    const sc = opts.scroller?.();
    let scrollTop: number;
    let viewportHeight: number;
    if (sc) {
      scrollTop = sc.getBoundingClientRect().top - top;
      viewportHeight = sc.clientHeight;
    } else {
      scrollTop = -top;
      viewportHeight = window.innerHeight;
    }
    return virtualWindow({ count, itemHeight, scrollTop, viewportHeight, overscan: opts.overscan });
  });
}

/** A tracked "narrow screen" flag: rows get taller (two lines) below this width. */
export function createNarrow(maxWidth = 640): Accessor<boolean> {
  const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
  const [narrow, setNarrow] = createSignal(mq.matches);
  const on = () => setNarrow(mq.matches);
  mq.addEventListener('change', on);
  onCleanup(() => mq.removeEventListener('change', on));
  return narrow;
}

export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight: number;
  /** The scrolling element (for lists inside a panel); the page when omitted. */
  scroller?: () => HTMLElement | undefined;
  class?: string;
  role?: 'list' | 'listbox';
  'aria-label'?: string;
  children: (item: T, index: Accessor<number>) => JSX.Element;
}

/** A fixed-height list that renders only the rows near the viewport (50k rows stay smooth). */
export function VirtualList<T>(props: VirtualListProps<T>) {
  let el: HTMLDivElement | undefined;
  const range = createVirtualWindow({
    container: () => el,
    scroller: props.scroller,
    count: () => props.items.length,
    itemHeight: () => props.itemHeight,
  });
  const slice = createMemo(() => props.items.slice(range().start, range().end));
  return (
    <div
      ref={el}
      class={`vlist ${props.class ?? ''}`}
      role={props.role}
      aria-label={props['aria-label']}
      style={{ height: `${range().totalHeight}px` }}
    >
      <For each={slice()}>
        {(item, i) => {
          const index = () => range().start + i();
          return (
            <div class="vrow" style={{ transform: `translateY(${index() * props.itemHeight}px)`, height: `${props.itemHeight}px` }}>
              {props.children(item, index)}
            </div>
          );
        }}
      </For>
    </div>
  );
}
