import { describe, expect, it } from 'vitest';
import { createPrimaryFacade } from './primary.ts';

class Stack {
  constructor(public n: number) {}
  value(): number { return this.n; }
  get label(): string { return `slot ${this.n}`; }
}

describe('createPrimaryFacade', () => {
  it('every call and read goes to the stack that is primary at that moment', () => {
    const stacks = [new Stack(0), new Stack(1)];
    let primary = 0;
    const facade = createPrimaryFacade(() => stacks[primary]!);
    expect(facade.value()).toBe(0);
    expect(facade.label).toBe('slot 0');
    const value = facade.value; // a method read once is still bound to its stack when called
    primary = 1;
    expect(facade.value()).toBe(1);
    expect(facade.label).toBe('slot 1');
    expect(value()).toBe(0);
  });

  it('optional methods read as undefined when the primary lacks them', () => {
    const facade = createPrimaryFacade<{ a?: () => number }>(() => ({}));
    expect(facade.a).toBeUndefined();
    expect('a' in facade).toBe(false);
  });
});
