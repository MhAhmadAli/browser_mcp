/** Chrome DevTools Protocol access to the connected tab. */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribes to a protocol event and returns a function that unsubscribes. */
  on<T>(event: string, listener: (params: T) => void): () => void;
}

type Frame = { id: string; loaderId: string; url: string };

type FrameEvent = { frameId: string };

export type NavigationHistory = {
  currentIndex: number;
  entries: { id: number; url: string; title: string }[];
};

const navigationStartWindowMs = 500;
const navigationTimeoutMs = 15000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getMainFrame(cdp: Cdp): Promise<Frame> {
  const { frameTree } = await cdp.send<{ frameTree: { frame: Frame } }>(
    "Page.getFrameTree",
  );
  return frameTree.frame;
}

export async function currentHistoryEntry(cdp: Cdp) {
  const { currentIndex, entries } = await cdp.send<NavigationHistory>(
    "Page.getNavigationHistory",
  );
  const entry = entries[currentIndex];
  if (!entry) {
    throw new Error("The tab has no current page.");
  }
  return entry;
}

/**
 * Runs `action`, then waits for any main-frame navigation it started to finish
 * loading, so a snapshot taken afterwards shows the new page.
 */
export async function runAndWaitForNavigation(
  cdp: Cdp,
  action: () => Promise<unknown>,
): Promise<void> {
  const { id: mainFrameId } = await getMainFrame(cdp);
  let started = false;
  let markStopped = () => {};
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  const offStarted = cdp.on<FrameEvent>(
    "Page.frameStartedLoading",
    ({ frameId }) => {
      if (frameId === mainFrameId) {
        started = true;
      }
    },
  );
  const offStopped = cdp.on<FrameEvent>(
    "Page.frameStoppedLoading",
    ({ frameId }) => {
      if (frameId === mainFrameId && started) {
        markStopped();
      }
    },
  );

  try {
    await action();
    const deadline = Date.now() + navigationStartWindowMs;
    while (!started && Date.now() < deadline) {
      await sleep(50);
    }
    if (started) {
      // Pages that never finish loading still get a snapshot, just a partial one
      await withTimeout(stopped, navigationTimeoutMs, "").catch(() => {});
    }
  } finally {
    offStarted();
    offStopped();
  }
}
