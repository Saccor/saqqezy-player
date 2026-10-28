import { For, View, type ElementNode, type JSX } from '@lightningtv/solid';
import { BOTTOM_ROW_Y } from '../shell/logic.ts';
import { LAYOUT } from '../shell/theme.ts';
import type { useRowColumn } from './rowColumn.ts';

/**
 * The paged rows of Start, Movies and Series: one focusable node that owns the keys, a wheel area from the first row
 * down to the shell's bottom row, and the rows at fixed y's in one column that slides (`useRowColumn`; a row sliding
 * out upwards is clipped at `clipTop`). `children` draws row `i` inside its slot.
 */
export function SlidingRows(props: {
  ref: (el: ElementNode) => void;
  /** The wheel area (from `top` down to the bottom row), registered by the screen as its pointer target. */
  wheelRef: (el: ElementNode) => void;
  column: ReturnType<typeof useRowColumn>;
  /** The focused row's y on screen. */
  top: number;
  /** The rows' clip edge (just above the focused row's title). */
  clipTop: number;
  onFocusChanged: (focused: boolean) => void;
  onUp: () => boolean;
  onDown: () => boolean;
  onLeft: () => boolean;
  onRight: () => boolean;
  onEnter: () => boolean;
  onMenu: () => boolean;
  onLongOk: () => boolean;
  children: (i: number) => JSX.Element;
}) {
  return (
    <View ref={props.ref} y={0} width={LAYOUT.width} height={LAYOUT.height} zIndex={3}
      onFocusChanged={props.onFocusChanged}
      onUp={props.onUp} onDown={props.onDown} onLeft={props.onLeft} onRight={props.onRight}
      onEnter={props.onEnter} onMenu={props.onMenu} onLongOk={props.onLongOk}>
      <View ref={props.wheelRef} y={props.top} width={LAYOUT.width} height={BOTTOM_ROW_Y - props.top} />
      <View y={props.clipTop} width={LAYOUT.width} height={LAYOUT.height - props.clipTop} clipping>
        <View ref={props.column.ref} width={LAYOUT.width} height={props.column.height()}>
          <For each={props.column.rows()}>{(i) => {
            // Built here, in the row's own scope (untracked, as a For callback): the row's memos belong to it.
            const content = props.children(i);
            return (
              <View y={props.column.rowY(i)} width={LAYOUT.width} height={props.column.rowH(i)}>
                {content}
              </View>
            );
          }}</For>
        </View>
      </View>
    </View>
  );
}
