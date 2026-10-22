import { describe, expect, it } from 'vitest';
import { classifyRefusal, createRefusalScope } from './refusalScope.ts';

describe('classifyRefusal', () => {
  it('a 403 while another session of the host is open stays on the tile', () => {
    expect(classifyRefusal({ httpStatus: 403, concurrent: 1 })).toBe('tile');
  });

  it('other refusal statuses, or none known, with another session open stay on the tile', () => {
    for (const httpStatus of [401, 458, 509, undefined]) expect(classifyRefusal({ httpStatus, concurrent: 2 })).toBe('tile');
  });

  it('429 and 503 mean too many requests: the host cools down', () => {
    expect(classifyRefusal({ httpStatus: 429, concurrent: 3 })).toBe('host');
    expect(classifyRefusal({ httpStatus: 503, concurrent: 1 })).toBe('host');
  });

  it('a refusal on the only session of the host is the host refusing us', () => {
    expect(classifyRefusal({ httpStatus: 403, concurrent: 0 })).toBe('host');
    expect(classifyRefusal({ httpStatus: 403 })).toBe('host');
  });
});

describe('createRefusalScope', () => {
  const tileRefusal = { httpStatus: 403, concurrent: 1 };

  it('the 4th tile refusal on a host within 10 min escalates to the host', () => {
    let t = 0;
    const scope = createRefusalScope(() => t);
    for (let i = 0; i < 3; i++) {
      expect(scope.decide('s@h', tileRefusal)).toBe('tile');
      t += 60_000;
    }
    expect(scope.decide('s@h', tileRefusal)).toBe('host');
  });

  it('refusals older than 10 min do not count', () => {
    let t = 0;
    const scope = createRefusalScope(() => t);
    for (let i = 0; i < 3; i++) scope.decide('s@h', tileRefusal);
    t = 600_000;
    expect(scope.decide('s@h', tileRefusal)).toBe('tile');
    expect(scope.tileRefusals('s@h')).toBe(1);
  });

  it('hosts are independent, and host-scoped refusals are not counted as tile refusals', () => {
    const scope = createRefusalScope(() => 0);
    for (let i = 0; i < 3; i++) scope.decide('s@a', tileRefusal);
    expect(scope.decide('s@b', tileRefusal)).toBe('tile');
    expect(scope.decide('s@a', { httpStatus: 429, concurrent: 1 })).toBe('host');
    expect(scope.tileRefusals('s@a')).toBe(3);
  });
});
