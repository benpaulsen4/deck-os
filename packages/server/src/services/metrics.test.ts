import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type SiMock = {
  currentLoad: ReturnType<typeof vi.fn>;
  cpu: ReturnType<typeof vi.fn>;
  cpuTemperature: ReturnType<typeof vi.fn>;
  mem: ReturnType<typeof vi.fn>;
  processes: ReturnType<typeof vi.fn>;
  fsSize: ReturnType<typeof vi.fn>;
  networkStats: ReturnType<typeof vi.fn>;
};

async function loadMetricsModule(options?: {
  useLinuxRAPL?: boolean;
  useLinuxHwmon?: boolean;
  cpuTempThrows?: boolean;
  raplEnergyValues?: string[];
}) {
  vi.resetModules();
  const readFileMock = vi.fn<(path: string, encoding: string) => Promise<string>>(
    async (_path: string, _encoding: string) => {
      throw new Error("ENOENT");
    }
  );
  const readdirMock = vi.fn<(path: string) => Promise<string[]>>(async (_path: string) => []);

  if (options?.useLinuxRAPL) {
    let energyIndex = 0;
    const energyValues = options.raplEnergyValues ?? ["1000000", "3000000"];
    readFileMock.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      if (normalized.endsWith("/sys/class/powercap/intel-rapl:0/energy_uj")) {
        const value = energyValues[Math.min(energyIndex, energyValues.length - 1)];
        energyIndex += 1;
        return value;
      }
      if (normalized.endsWith("/sys/class/powercap/intel-rapl:0/max_energy_range_uj")) {
        return "10000000";
      }
      throw new Error("ENOENT");
    });
  }

  if (options?.useLinuxHwmon) {
    readFileMock.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      if (normalized.endsWith("/sys/class/powercap/intel-rapl:0/energy_uj")) {
        throw new Error("ENOENT");
      }
      if (normalized.endsWith("/sys/class/hwmon/hwmon0/name")) {
        return "zenpower";
      }
      if (normalized.endsWith("/sys/class/hwmon/hwmon0/power1_average")) {
        return "42000000";
      }
      throw new Error("ENOENT");
    });
    readdirMock.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      if (normalized === "/sys/class/hwmon") {
        return ["hwmon0"];
      }
      return [];
    });
  }

  const siMock: SiMock = {
    currentLoad: vi.fn(async () => ({
      currentLoad: 11,
      currentLoadUser: 6,
      currentLoadSystem: 5,
      currentLoadIdle: 89,
    })),
    cpu: vi.fn(async () => ({ cores: 8, speed: 2.9 })),
    cpuTemperature: vi.fn(async () => {
      if (options?.cpuTempThrows) {
        throw new Error("temp");
      }
      return { main: 55 };
    }),
    mem: vi.fn(async () => ({
      total: 1000,
      used: 400,
      free: 600,
      swaptotal: 200,
      swapused: 50,
    })),
    processes: vi.fn(async () => ({ all: 100, running: 5, blocked: 1, sleeping: 94 })),
    fsSize: vi.fn(async () => [
      { fs: "/dev/sda1", mount: "/", size: 1000, used: 500, use: 50, type: "ext4" },
      { fs: "tmpfs", mount: "/run", size: 100, used: 20, use: 20, type: "tmpfs" },
    ]),
    networkStats: vi.fn(async () => [
      { iface: "eth0", rx_bytes: 10, tx_bytes: 20, rx_sec: 1, tx_sec: 2 },
    ]),
  };

  vi.doMock("systeminformation", () => ({
    default: siMock,
  }));
  vi.doMock("node:fs/promises", () => ({
    readFile: readFileMock,
    readdir: readdirMock,
  }));
  vi.doMock("../lib/config.js", async () => {
    const actual = await vi.importActual<typeof import("../lib/config.js")>("../lib/config.js");
    return {
      ...actual,
      POLL_INTERVAL_MS: 20,
      METRICS_HISTORY_SIZE: 3,
    };
  });
  const metrics = await import("./metrics.js");
  return { metrics, siMock, readFileMock, readdirMock };
}

describe("metrics service", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("getOneShotMetrics fills the cache without writing history or notifying subscribers", async () => {
    const { metrics } = await loadMetricsModule();

    // Nobody is subscribed, so nothing is polling: this is purely the query path.
    const snapshot = await metrics.getOneShotMetrics();

    expect(snapshot.cpu.usage).toBe(11);
    expect(snapshot.memory.usage).toBe(40);
    expect(snapshot.disk.fs).toHaveLength(1);
    expect(snapshot.network.interfaces.eth0.tx_sec).toBe(2);
    expect(metrics.getCachedMetrics()).toBe(snapshot);
    // History and subscriber fan-out belong to the poller alone (UPD-11).
    expect(metrics.getMetricsHistory().length).toBe(0);

    const received: string[] = [];
    const unsubscribe = metrics.subscribeToMetrics((payload) => {
      received.push(payload.timestamp);
    });
    await vi.advanceTimersByTimeAsync(5);
    const framesFromPoller = received.length;
    const historyFromPoller = metrics.getMetricsHistory().length;
    expect(framesFromPoller).toBeGreaterThan(0);

    // A query alongside a running poller still adds no frame and no history entry.
    await metrics.getOneShotMetrics();

    expect(received.length).toBe(framesFromPoller);
    expect(metrics.getMetricsHistory().length).toBe(historyFromPoller);
    unsubscribe();
  });

  test("subscribing starts the poller and an explicit start without subscribers does not", async () => {
    const { metrics, siMock } = await loadMetricsModule();

    // No production caller remains -- the SSE handler's call was removed once
    // polling became refcounted on the subscriber set. The export survives as
    // this lever: an explicit start with no subscribers must stay a no-op,
    // and only `subscribeToMetrics()` below should actually start the poller.
    metrics.startMetricsPolling();
    await vi.advanceTimersByTimeAsync(100);
    expect(siMock.currentLoad.mock.calls.length).toBe(0);

    const unsubscribe = metrics.subscribeToMetrics(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThan(0);

    unsubscribe();
    const callsAfterUnsubscribe = siMock.currentLoad.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(siMock.currentLoad.mock.calls.length).toBe(callsAfterUnsubscribe);
  });

  test("a collector that has never succeeded fails the collection instead of publishing zeros", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      siMock.mem.mockRejectedValue(new Error("no /proc/meminfo"));

      await expect(metrics.getOneShotMetrics()).rejects.toThrow(
        /no data has ever been collected for: memory/
      );
      expect(metrics.getCachedMetrics()).toBeNull();
      expect(metrics.getMetricsHistory().length).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("concurrent collections share a single in-flight cycle", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    siMock.currentLoad.mockImplementationOnce(async () => {
      await gate;
      return {
        currentLoad: 11,
        currentLoadUser: 6,
        currentLoadSystem: 5,
        currentLoadIdle: 89,
      };
    });

    const first = metrics.getOneShotMetrics();
    const second = metrics.getOneShotMetrics();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(siMock.currentLoad.mock.calls.length).toBe(1);
    expect(siMock.networkStats.mock.calls.length).toBe(1);
  });

  test("overlapping collections cannot split a delta-based power reading", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { metrics } = await loadMetricsModule({
      useLinuxRAPL: true,
      // Discovery consumes the first value, then one per collection.
      raplEnergyValues: ["1000000", "2000000", "3000000", "4000000"],
    });

    const primed = await metrics.getOneShotMetrics();
    expect(primed.cpu.powerWatts).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    const [a, b] = await Promise.all([
      metrics.getOneShotMetrics(),
      metrics.getOneShotMetrics(),
    ]);

    // One 1,000,000 uJ delta over one second: exactly 1W, reported once.
    expect(a).toBe(b);
    expect(a.cpu.powerWatts).toBe(1);
    expect(b.cpu.powerWatts).toBe(1);
  });

  test("getMetricsSnapshot serves the poller cache and collects only when stale", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const unsubscribe = metrics.subscribeToMetrics(() => undefined);
    await vi.advanceTimersByTimeAsync(5);

    const historyLength = metrics.getMetricsHistory().length;
    const callsBefore = siMock.currentLoad.mock.calls.length;
    const cached = await metrics.getMetricsSnapshot();

    expect(cached).toBe(metrics.getCachedMetrics());
    expect(siMock.currentLoad.mock.calls.length).toBe(callsBefore);
    expect(metrics.getMetricsHistory().length).toBe(historyLength);

    // Polling stops with the last subscriber, so the cache eventually ages out
    // and the query has to collect instead of serving something arbitrarily old.
    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    const fresh = await metrics.getMetricsSnapshot();

    expect(fresh).not.toBe(cached);
    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(metrics.getMetricsHistory().length).toBe(historyLength);
  });

  test("one failing collector degrades a single section instead of blanking the snapshot", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const healthy = await metrics.getOneShotMetrics();
      expect(healthy.disk.fs).toHaveLength(1);

      siMock.fsSize.mockRejectedValue(new Error("stale NFS mount"));
      const degraded = await metrics.getOneShotMetrics();

      expect(degraded).not.toBe(healthy);
      expect(degraded.cpu.usage).toBe(11);
      expect(degraded.memory.usage).toBe(40);
      expect(degraded.network.interfaces.eth0.tx_sec).toBe(2);
      expect(degraded.disk.fs).toEqual(healthy.disk.fs);
      expect(metrics.getCachedMetrics()).toBe(degraded);

      // A permanently broken collector must not log on every cycle.
      await metrics.getOneShotMetrics();
      await metrics.getOneShotMetrics();
      const diskFailureLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes('collector "disk" failed')
      );
      expect(diskFailureLogs).toHaveLength(1);

      siMock.fsSize.mockResolvedValue([
        { fs: "/dev/sda1", mount: "/", size: 1000, used: 750, use: 75, type: "ext4" },
      ]);
      const recovered = await metrics.getOneShotMetrics();

      expect(recovered.disk.fs[0].usePercent).toBe(75);
      const recoveryLogs = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('collector "disk" recovered')
      );
      expect(recoveryLogs).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("a total collector failure keeps the previous cache and logs once per cycle set", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const unsubscribe = metrics.subscribeToMetrics(() => undefined);
      await vi.advanceTimersByTimeAsync(5);
      expect(metrics.getCachedMetrics()).not.toBeNull();

      const boom = new Error("collector down");
      siMock.currentLoad.mockRejectedValue(boom);
      siMock.mem.mockRejectedValue(boom);
      siMock.processes.mockRejectedValue(boom);
      siMock.fsSize.mockRejectedValue(boom);
      siMock.networkStats.mockRejectedValue(boom);

      // Process counts are served from the slower sub-interval sample, so every
      // section only fails once that sample has expired too.
      await vi.advanceTimersByTimeAsync(10_100);
      const lastPublished = metrics.getCachedMetrics();
      await vi.advanceTimersByTimeAsync(200);

      expect(metrics.getCachedMetrics()).toBe(lastPublished);
      expect(metrics.getMetricsHistory().at(-1)).toBe(lastPublished);
      const pollFailureLogs = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Metrics polling failed")
      );
      expect(pollFailureLogs).toHaveLength(1);

      unsubscribe();
      metrics.stopMetricsPolling();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("process counts are sampled on a slower sub-interval than the poll", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const unsubscribe = metrics.subscribeToMetrics(() => undefined);

    await vi.advanceTimersByTimeAsync(100);

    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(siMock.processes.mock.calls.length).toBe(1);
    expect(metrics.getCachedMetrics()?.processes.all).toBe(100);

    siMock.processes.mockResolvedValue({
      all: 111,
      running: 6,
      blocked: 0,
      sleeping: 105,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(siMock.processes.mock.calls.length).toBe(2);
    expect(metrics.getCachedMetrics()?.processes.all).toBe(111);

    unsubscribe();
    metrics.stopMetricsPolling();
  });

  test("polling stops when the last subscriber leaves and resumes for the next one", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const unsubscribeA = metrics.subscribeToMetrics(() => undefined);
    const unsubscribeB = metrics.subscribeToMetrics(() => undefined);

    await vi.advanceTimersByTimeAsync(50);

    const callsWithTwoSubscribers = siMock.currentLoad.mock.calls.length;
    unsubscribeA();
    await vi.advanceTimersByTimeAsync(50);
    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThan(
      callsWithTwoSubscribers
    );

    unsubscribeB();
    const callsAfterLastLeft = siMock.currentLoad.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(siMock.currentLoad.mock.calls.length).toBe(callsAfterLastLeft);

    const unsubscribeC = metrics.subscribeToMetrics(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThan(callsAfterLastLeft);

    unsubscribeC();
    metrics.stopMetricsPolling();
  });

  test("the poller collects repeatedly and an explicit stop halts it", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const unsubscribe = metrics.subscribeToMetrics(() => undefined);

    await vi.advanceTimersByTimeAsync(5);
    expect(metrics.getMetricsHistory().length).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(metrics.getMetricsHistory().length).toBe(3);
    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThanOrEqual(3);

    metrics.stopMetricsPolling();
    const callCountAfterStop = siMock.currentLoad.mock.calls.length;
    await vi.advanceTimersByTimeAsync(80);
    expect(siMock.currentLoad.mock.calls.length).toBe(callCountAfterStop);
    unsubscribe();
  });

  test("extra subscribers and start calls do not stack a second interval", async () => {
    const { metrics, siMock } = await loadMetricsModule();

    const unsubscribeA = metrics.subscribeToMetrics(() => undefined);
    await vi.advanceTimersByTimeAsync(50);
    const callsWithOneSubscriber = siMock.currentLoad.mock.calls.length;
    expect(callsWithOneSubscriber).toBeGreaterThanOrEqual(2);

    const unsubscribeB = metrics.subscribeToMetrics(() => undefined);
    metrics.startMetricsPolling();
    metrics.startMetricsPolling();
    await vi.advanceTimersByTimeAsync(50);

    // A second interval would roughly double the collections over this window.
    const callsAdded = siMock.currentLoad.mock.calls.length - callsWithOneSubscriber;
    expect(callsAdded).toBeLessThanOrEqual(callsWithOneSubscriber + 1);

    unsubscribeA();
    unsubscribeB();
    metrics.stopMetricsPolling();
  });

  test("linux RAPL path computes CPU power after second sample", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { metrics } = await loadMetricsModule({ useLinuxRAPL: true });

    const first = await metrics.getOneShotMetrics();
    await vi.advanceTimersByTimeAsync(1000);
    const second = await metrics.getOneShotMetrics();

    expect(first.cpu.powerWatts).toBeNull();
    expect(second.cpu.powerWatts).not.toBeNull();
    expect((second.cpu.powerWatts as number) >= 0).toBe(true);
  });

  test("stopping the poller re-primes the RAPL baseline instead of spanning the gap", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { metrics } = await loadMetricsModule({
      useLinuxRAPL: true,
      raplEnergyValues: ["1000000", "2000000", "3000000", "4000000"],
    });

    await metrics.getOneShotMetrics();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await metrics.getOneShotMetrics()).cpu.powerWatts).toBe(1);

    metrics.stopMetricsPolling();
    await vi.advanceTimersByTimeAsync(600_000);

    // No baseline to measure against after an unbounded idle gap.
    expect((await metrics.getOneShotMetrics()).cpu.powerWatts).toBeNull();
  });

  test("linux hwmon fallback reports power when RAPL is unavailable", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { metrics } = await loadMetricsModule({ useLinuxHwmon: true, cpuTempThrows: true });

    const snapshot = await metrics.getOneShotMetrics();

    expect(snapshot.cpu.powerWatts).toBe(42);
    expect(snapshot.cpu.temperatureC).toBeNull();
  });
});
