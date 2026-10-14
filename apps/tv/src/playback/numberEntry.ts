/** Remote number entry: digits accumulate (up to `maxDigits`) and submit after `idleMs` without input, or on Ok. */
export interface NumberEntry {
  digit(d: number): void;
  /** Submits now; false when nothing was entered. */
  submit(): boolean;
  clear(): void;
  text(): string;
  active(): boolean;
}

export function createNumberEntry(opts: {
  idleMs: number;
  maxDigits: number;
  onChange(text: string): void;
  onSubmit(n: number): void;
}): NumberEntry {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const set = (t: string) => {
    text = t;
    opts.onChange(t);
  };
  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const submit = () => {
    stopTimer();
    if (!text) return false;
    const n = Number(text);
    set('');
    opts.onSubmit(n);
    return true;
  };

  return {
    digit(d) {
      if (!Number.isInteger(d) || d < 0 || d > 9) return;
      if (text.length < opts.maxDigits) set(text + String(d));
      stopTimer();
      timer = setTimeout(submit, opts.idleMs);
    },
    submit,
    clear() {
      stopTimer();
      if (text) set('');
    },
    text: () => text,
    active: () => text.length > 0,
  };
}
