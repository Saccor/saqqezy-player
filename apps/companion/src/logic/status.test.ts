import { describe, expect, it } from 'vitest';
import { COPY } from './copy.ts';
import { linkView } from './status.ts';

describe('linkView', () => {
  it('is online (green dot, "Connected") only with the link up and the state answered', () => {
    expect(linkView('online', 'ok')).toEqual({ online: true, text: undefined });
  });

  it('is not online while a Retry is running or after the TV stopped answering', () => {
    expect(linkView('online', 'retrying')).toEqual({ online: false, text: COPY.notAnswering });
    expect(linkView('online', 'unanswered')).toEqual({ online: false, text: COPY.notAnswering });
  });

  it('shows the link state while the link is down', () => {
    expect(linkView('reconnecting', 'ok')).toEqual({ online: false, text: 'Reconnecting…' });
    expect(linkView('connecting', 'ok')).toEqual({ online: false, text: 'Connecting…' });
  });
});
