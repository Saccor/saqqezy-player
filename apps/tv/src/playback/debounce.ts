/** Trailing debounce: `fn` runs with the last scheduled value once nothing new was scheduled for `ms`. */
export interface Debounce<T> {
  schedule(value: T): void;
  cancel(): void;
  pending(): boolean;
}

export function createDebounce<T>(ms: number, fn: (value: T) => void): Debounce<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    schedule(value) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        fn(value);
      }, ms);
    },
    cancel,
    pending: () => timer !== undefined,
  };
}
