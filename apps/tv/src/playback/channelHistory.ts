/** In-session "previous channel" tracking for the Red toggle. */
export interface ChannelHistory {
  /** Records that `id` is now playing; the channel before it becomes `previous()`. */
  visit(id: string): void;
  current(): string | undefined;
  previous(): string | undefined;
}

export function createChannelHistory(): ChannelHistory {
  let cur: string | undefined;
  let prev: string | undefined;
  return {
    visit(id) {
      if (id === cur) return;
      prev = cur;
      cur = id;
    },
    current: () => cur,
    previous: () => prev,
  };
}

/** Shared across Player visits, so Red still works after going to Home and back. */
export const channelHistory = createChannelHistory();
