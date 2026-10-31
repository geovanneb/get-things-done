/**
 * The server sends `connected` each time the live event stream opens. The very first one, with no failure
 * before it, is the page's own start. Any other means the stream was down for a while (dropped, or never got
 * through), and file changes made meanwhile were never announced, so the page must read everything again (#201).
 */
export function streamTracker(): { failed: () => void; connected: () => boolean } {
  let opened = false;
  let failedSince = false;
  return {
    failed: () => { failedSince = true; },
    connected: () => {
      const missed = opened || failedSince;
      opened = true;
      failedSince = false;
      return missed;
    },
  };
}

/** How long to wait before opening a new stream once the browser has given up on the old one. */
export const RECONNECT_DELAY_MS = 5000;
