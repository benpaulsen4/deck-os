const TICK_MS = 5;

const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `start` and reports the longest the event loop went without running a timer.
 * The timer is armed before `start` is called, and gets a chance to fire after `work`
 * settles, because a stall is only seen by the first tick after it ends. Measuring from
 * after the call, or stopping as soon as `work` settles, reports no gap at all for code
 * that blocks.
 */
export async function measureEventLoopGap<T>(
  start: () => Promise<T>
): Promise<{ gapMs: number; work: Promise<T> }> {
  let last = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, TICK_MS);
  await elapse(4 * TICK_MS);

  const work = start();
  await work.then(
    () => undefined,
    () => undefined
  );

  await elapse(4 * TICK_MS);
  clearInterval(timer);
  return { gapMs, work };
}
