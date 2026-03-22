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
}) {
  vi.resetModules();
  const readFileMock: any = vi.fn(async (_path: string, _encoding: string) => {
    throw new Error("ENOENT");
  });
  const readdirMock: any = vi.fn(async (_path: string) => []);

  if (options?.useLinuxRAPL) {
    let energyIndex = 0;
    const energyValues = ["1000000", "3000000"];
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

  test("getOneShotMetrics populates cache/history and notifies subscribers", async () => {
    const { metrics } = await loadMetricsModule();
    const received: string[] = [];
    const unsubscribe = metrics.subscribeToMetrics((payload) => {
      received.push(payload.timestamp);
    });

    const snapshot = await metrics.getOneShotMetrics();
    unsubscribe();

    expect(snapshot.cpu.usage).toBe(11);
    expect(snapshot.memory.usage).toBe(40);
    expect(snapshot.disk.fs).toHaveLength(1);
    expect(snapshot.network.interfaces.eth0.tx_sec).toBe(2);
    expect(metrics.getCachedMetrics()).not.toBeNull();
    expect(metrics.getMetricsHistory().length).toBe(1);
    expect(received.length).toBe(1);
  });

  test("startMetricsPolling collects repeatedly and stop halts polling", async () => {
    const { metrics, siMock } = await loadMetricsModule();
    const unsubscribe = metrics.subscribeToMetrics(() => undefined);

    metrics.startMetricsPolling();
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

  test("startMetricsPolling is idempotent for active interval", async () => {
    const { metrics, siMock } = await loadMetricsModule();

    metrics.startMetricsPolling();
    metrics.startMetricsPolling();
    await vi.advanceTimersByTimeAsync(50);
    metrics.stopMetricsPolling();

    expect(siMock.currentLoad.mock.calls.length).toBeGreaterThanOrEqual(2);
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

  test("linux hwmon fallback reports power when RAPL is unavailable", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { metrics } = await loadMetricsModule({ useLinuxHwmon: true, cpuTempThrows: true });

    const snapshot = await metrics.getOneShotMetrics();

    expect(snapshot.cpu.powerWatts).toBe(42);
    expect(snapshot.cpu.temperatureC).toBeNull();
  });
});
