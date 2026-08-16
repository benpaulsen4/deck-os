import si from "systeminformation";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SystemMetrics,
  CPUMetrics,
  MemoryMetrics,
  DiskMetrics,
  NetworkMetrics,
  ProcessMetrics,
} from "../lib/schema.js";
import { POLL_INTERVAL_MS, METRICS_HISTORY_SIZE } from "../lib/config.js";

let cachedMetrics: SystemMetrics | null = null;
let cachedMetricsAtMs: number | null = null;
const metricsSubscribers: Set<(metrics: SystemMetrics) => void> = new Set();
let pollInterval: NodeJS.Timeout | null = null;
const metricsHistory: SystemMetrics[] = [];

/**
 * `si.currentLoad()`, `si.networkStats()` and the RAPL energy counter are all
 * delta-based over module-level state, so two overlapping collections would
 * split one interval's delta across two samples (one absurdly high, the next
 * near zero). Concurrent callers therefore share a single in-flight collection.
 */
let inFlightCollection: Promise<SystemMetrics> | null = null;

/** Guards against publishing the same shared collection to history twice. */
let lastPublishedMetrics: SystemMetrics | null = null;

/**
 * A full process-table enumeration shells out to `ps` on Linux, which is far
 * too expensive to run on the 2-second poll interval just to fill four
 * integers. Counts are re-sampled on this slower sub-interval instead.
 */
const PROCESS_SAMPLE_INTERVAL_MS = 10_000;
let lastProcessMetrics: ProcessMetrics | null = null;
let lastProcessSampleAtMs: number | null = null;

/**
 * Polling stops once the last SSE subscriber disconnects, so the cache can be
 * arbitrarily old by the time a `getMetrics` query arrives. Beyond this age the
 * query collects instead of serving the cache.
 */
const CACHED_METRICS_MAX_AGE_MS = POLL_INTERVAL_MS * 2;

type MetricsSection = "cpu" | "memory" | "processes" | "disk" | "network";

/** Sections currently failing, so each broken collector is logged once. */
const failingSections = new Set<MetricsSection>();
let pollFailureLogged = false;

let cpuPowerPath: string | null | undefined = undefined;
let cpuPowerMode: "rapl_energy" | "hwmon_power" | null | undefined = undefined;
let raplMaxEnergyRangeUj: number | null = null;
let lastRaplDiscoveryAtMs = 0;
let lastCpuEnergyUj: number | null = null;
let lastCpuEnergyAtMs: number | null = null;
const RAPL_REDISCOVERY_INTERVAL_MS = 60_000;
const cpuPowerPermissionWarningPaths = new Set<string>();
let cpuPowerSourceWarningLogged = false;

function logCpuPowerPermissionIssue(path: string, error: unknown): void {
  if (
    !path.startsWith("/sys/class/powercap") &&
    !path.startsWith("/sys/class/hwmon") &&
    !path.startsWith("/sys/devices/platform/zenpower.0/hwmon")
  ) {
    return;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "EACCES" && code !== "EPERM") return;
  if (cpuPowerPermissionWarningPaths.has(path)) return;
  cpuPowerPermissionWarningPaths.add(path);
  console.warn(
    `[deckos] CPU power metric cannot read ${path} (${code}). Grant deckos read access to powercap/hwmon sysfs files.`
  );
}

async function readNumberFromFile(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const value = Number.parseFloat(raw.trim());
    return Number.isFinite(value) ? value : null;
  } catch (error: unknown) {
    logCpuPowerPermissionIssue(path, error);
    return null;
  }
}

async function findRaplEnergyPath(): Promise<string | null> {
  const candidates = [
    "/sys/class/powercap/intel-rapl:0/energy_uj",
    "/sys/class/powercap/amd-rapl:0/energy_uj",
  ];

  for (const candidate of candidates) {
    const v = await readNumberFromFile(candidate);
    if (v !== null) return candidate;
  }

  const base = "/sys/class/powercap";
  try {
    const scan = async (dir: string, depth: number): Promise<string | null> => {
      if (depth < 0) return null;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        const energyPath = join(child, "energy_uj");
        const v = await readNumberFromFile(energyPath);
        if (v !== null) return energyPath;
        const nested = await scan(child, depth - 1);
        if (nested) return nested;
      }
      return null;
    };

    return await scan(base, 2);
  } catch {
    return null;
  }
}

async function findHwmonPowerPath(): Promise<string | null> {
  const bases = ["/sys/class/hwmon", "/sys/devices/platform/zenpower.0/hwmon"];
  const matches: Array<{ path: string; score: number }> = [];

  for (const base of bases) {
    try {
      const entries = await readdir(base);
      for (const entry of entries) {
        if (!entry.startsWith("hwmon")) continue;
        const hwmonDir = join(base, entry);
        const sensorName = (
          (await readFile(join(hwmonDir, "name"), "utf8").catch(() => "")) || ""
        )
          .trim()
          .toLowerCase();
        const baseScore = sensorName.includes("zenpower")
          ? 3
          : sensorName.includes("k10temp")
            ? 2
            : sensorName.includes("coretemp") || sensorName.includes("cpu")
              ? 1
              : 0;

        const averagePath = join(hwmonDir, "power1_average");
        if ((await readNumberFromFile(averagePath)) !== null) {
          matches.push({ path: averagePath, score: baseScore + 2 });
        }

        const inputPath = join(hwmonDir, "power1_input");
        if ((await readNumberFromFile(inputPath)) !== null) {
          matches.push({ path: inputPath, score: baseScore + 1 });
        }
      }
    } catch {
      continue;
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score);
  return matches[0].path;
}

async function discoverRaplEnergyPath(nowMs: number): Promise<void> {
  lastRaplDiscoveryAtMs = nowMs;
  cpuPowerPath = null;
  cpuPowerMode = null;
  raplMaxEnergyRangeUj = null;
  lastCpuEnergyUj = null;
  lastCpuEnergyAtMs = null;

  const raplPath = await findRaplEnergyPath();
  if (raplPath) {
    cpuPowerPath = raplPath;
    cpuPowerMode = "rapl_energy";
    const maxRangePath = join(dirname(raplPath), "max_energy_range_uj");
    raplMaxEnergyRangeUj = await readNumberFromFile(maxRangePath);
    return;
  }

  const hwmonPath = await findHwmonPowerPath();
  if (hwmonPath) {
    cpuPowerPath = hwmonPath;
    cpuPowerMode = "hwmon_power";
    cpuPowerSourceWarningLogged = false;
    return;
  }
  if (!cpuPowerSourceWarningLogged) {
    cpuPowerSourceWarningLogged = true;
    console.warn(
      "[deckos] CPU power metric source unavailable. Ensure powercap/hwmon sensors exist and deckos can read them."
    );
  }
}

async function readCpuPowerWatts(nowMs: number): Promise<number | null> {
  if (process.platform !== "linux") return null;

  if (
    cpuPowerPath === undefined ||
    (cpuPowerPath === null &&
      nowMs - lastRaplDiscoveryAtMs >= RAPL_REDISCOVERY_INTERVAL_MS)
  ) {
    await discoverRaplEnergyPath(nowMs);
  }
  if (!cpuPowerPath || !cpuPowerMode) return null;

  if (cpuPowerMode === "hwmon_power") {
    const rawPower = await readNumberFromFile(cpuPowerPath);
    if (rawPower === null || rawPower < 0) {
      cpuPowerPath = null;
      cpuPowerMode = null;
      return null;
    }
    const watts = rawPower / 1_000_000;
    return Number.isFinite(watts) && watts >= 0 ? watts : null;
  }

  const energyUj = await readNumberFromFile(cpuPowerPath);
  if (energyUj === null) {
    cpuPowerPath = null;
    cpuPowerMode = null;
    raplMaxEnergyRangeUj = null;
    lastCpuEnergyUj = null;
    lastCpuEnergyAtMs = null;
    return null;
  }

  if (lastCpuEnergyUj === null || lastCpuEnergyAtMs === null) {
    lastCpuEnergyUj = energyUj;
    lastCpuEnergyAtMs = nowMs;
    return null;
  }

  const previousEnergyUj = lastCpuEnergyUj;
  const previousEnergyAtMs = lastCpuEnergyAtMs;
  let deltaUj = energyUj - previousEnergyUj;
  const deltaS = (nowMs - previousEnergyAtMs) / 1000;

  if (deltaUj < 0) {
    if (raplMaxEnergyRangeUj && raplMaxEnergyRangeUj > 0) {
      deltaUj = raplMaxEnergyRangeUj - previousEnergyUj + energyUj;
    } else {
      lastCpuEnergyUj = energyUj;
      lastCpuEnergyAtMs = nowMs;
      return null;
    }
  }

  lastCpuEnergyUj = energyUj;
  lastCpuEnergyAtMs = nowMs;

  if (deltaUj < 0 || deltaS <= 0) return null;
  const watts = deltaUj / 1_000_000 / deltaS;
  return Number.isFinite(watts) && watts >= 0 ? watts : null;
}

async function collectCPUMetrics(): Promise<CPUMetrics> {
  const cpuLoad = await si.currentLoad();
  const cpu = await si.cpu();
  const nowMs = Date.now();

  let temperatureC: number | null = null;
  try {
    const temp = await si.cpuTemperature();
    if (typeof temp.main === "number" && Number.isFinite(temp.main) && temp.main > 0) {
      temperatureC = temp.main;
    }
  } catch {
    temperatureC = null;
  }

  const powerWatts = await readCpuPowerWatts(nowMs);
  return {
    usage: cpuLoad.currentLoad,
    load: [cpuLoad.currentLoadUser, cpuLoad.currentLoadSystem, cpuLoad.currentLoadIdle],
    cores: cpu.cores,
    speed: cpu.speed,
    temperatureC,
    powerWatts,
  };
}

async function collectMemoryMetrics(): Promise<MemoryMetrics> {
  const mem = await si.mem();
  const total = mem.total;
  const used = mem.used;
  const swapTotal = mem.swaptotal || 0;
  const swapUsed = mem.swapused || 0;
  return {
    total,
    used,
    free: mem.free,
    usage: (used / total) * 100,
    swapTotal,
    swapUsed,
    swapFree: Math.max(0, swapTotal - swapUsed),
    swapUsage: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0,
  };
}

async function collectProcessMetrics(): Promise<ProcessMetrics> {
  const nowMs = Date.now();
  if (
    lastProcessMetrics !== null &&
    lastProcessSampleAtMs !== null &&
    nowMs - lastProcessSampleAtMs < PROCESS_SAMPLE_INTERVAL_MS
  ) {
    return lastProcessMetrics;
  }

  const processes = await si.processes();
  const sample: ProcessMetrics = {
    all: processes.all,
    running: processes.running,
    blocked: processes.blocked,
    sleeping: processes.sleeping,
  };
  lastProcessMetrics = sample;
  lastProcessSampleAtMs = nowMs;
  return sample;
}

async function collectDiskMetrics(): Promise<DiskMetrics> {
  const fsSize = await si.fsSize();
  const realFileSystems = fsSize.filter((fs) => {
    const fsType = (fs.type || "").toLowerCase();
    const fsName = (fs.fs || "").toLowerCase();
    const mount = (fs.mount || "").toLowerCase();
    if (fsType === "tmpfs" || fsType === "swap" || fsType === "efivarfs") return false;
    if (fsName.includes("efivars")) return false;
    if (mount.includes("/efivars")) return false;
    return true;
  });
  return {
    fs: realFileSystems.map((fs) => ({
      fs: fs.fs,
      mount: fs.mount,
      size: fs.size,
      used: fs.used,
      usePercent: fs.use,
    })),
  };
}

async function collectNetworkMetrics(): Promise<NetworkMetrics> {
  const networkStats = await si.networkStats();
  const interfaces: Record<
    string,
    {
      rx_bytes: number;
      tx_bytes: number;
      rx_sec: number;
      tx_sec: number;
    }
  > = {};

  for (const iface of networkStats) {
    interfaces[iface.iface] = {
      rx_bytes: iface.rx_bytes,
      tx_bytes: iface.tx_bytes,
      rx_sec: iface.rx_sec,
      tx_sec: iface.tx_sec,
    };
  }

  return { interfaces };
}

/**
 * Resolves one section of a settled collection: the fresh value when the
 * collector succeeded, otherwise the previous value for that section, or null
 * when that collector has never produced one. A single flaky collector must not
 * blank the whole snapshot, and a permanently broken one must not log on every
 * tick, so failures are logged on the transition into and out of failure.
 */
function resolveSection<K extends MetricsSection>(
  section: K,
  result: PromiseSettledResult<SystemMetrics[K]>,
  previous: SystemMetrics[K] | undefined
): SystemMetrics[K] | null {
  if (result.status === "fulfilled") {
    if (failingSections.delete(section)) {
      console.warn(`[deckos] Metrics collector "${section}" recovered.`);
    }
    return result.value;
  }

  if (!failingSections.has(section)) {
    failingSections.add(section);
    console.error(
      `[deckos] Metrics collector "${section}" failed; keeping last known value for it:`,
      result.reason
    );
  }
  return previous ?? null;
}

async function collectMetricsUncoordinated(): Promise<SystemMetrics> {
  const previous = cachedMetrics;
  const results = await Promise.allSettled([
    collectCPUMetrics(),
    collectMemoryMetrics(),
    collectProcessMetrics(),
    collectDiskMetrics(),
    collectNetworkMetrics(),
  ]);
  const [cpuResult, memoryResult, processesResult, diskResult, networkResult] = results;

  const sections = {
    cpu: resolveSection("cpu", cpuResult, previous?.cpu),
    memory: resolveSection("memory", memoryResult, previous?.memory),
    processes: resolveSection("processes", processesResult, previous?.processes),
    disk: resolveSection("disk", diskResult, previous?.disk),
    network: resolveSection("network", networkResult, previous?.network),
  };

  // Degrading to a stale section is honest; fabricating one is not. A section
  // that has never succeeded would have to be invented from zeroes, which reads
  // downstream as a genuinely idle machine, so treat it as a failed collection
  // and leave the cache untouched instead. This subsumes the all-collectors-
  // failed case.
  // Every collector failed at once: the machine, not one subsystem, is the
  // problem. Publishing an entirely stale snapshot under a fresh timestamp would
  // present a frozen host as a live one, so leave the cache alone.
  if (results.every((result) => result.status === "rejected")) {
    throw new Error(
      `All metrics collectors failed (${(Object.keys(sections) as MetricsSection[]).join(", ")})`
    );
  }

  const { cpu, memory, processes, disk, network } = sections;
  if (
    cpu === null ||
    memory === null ||
    processes === null ||
    disk === null ||
    network === null
  ) {
    const unavailable = (Object.keys(sections) as MetricsSection[]).filter(
      (section) => sections[section] === null
    );
    throw new Error(
      `Metrics collection incomplete; no data has ever been collected for: ${unavailable.join(", ")}`
    );
  }

  const metrics: SystemMetrics = {
    cpu,
    memory,
    processes,
    disk,
    network,
    timestamp: new Date().toISOString(),
  };

  cachedMetrics = metrics;
  cachedMetricsAtMs = Date.now();
  return metrics;
}

function collectMetrics(): Promise<SystemMetrics> {
  if (inFlightCollection) {
    return inFlightCollection;
  }

  const collection = collectMetricsUncoordinated().finally(() => {
    if (inFlightCollection === collection) {
      inFlightCollection = null;
    }
  });
  inFlightCollection = collection;
  return collection;
}

/**
 * History and subscriber fan-out belong to the poller alone: a read-only query
 * must not evict genuine interval samples or push duplicate frames to every
 * connected dashboard.
 */
function publishMetrics(metrics: SystemMetrics): void {
  if (lastPublishedMetrics === metrics) return;
  lastPublishedMetrics = metrics;

  metricsHistory.push(metrics);
  if (metricsHistory.length > METRICS_HISTORY_SIZE) {
    metricsHistory.shift();
  }

  metricsSubscribers.forEach((subscriber) => {
    subscriber(metrics);
  });
}

async function runPollCycle(): Promise<void> {
  try {
    const metrics = await collectMetrics();
    pollFailureLogged = false;
    publishMetrics(metrics);
  } catch (error: unknown) {
    if (pollFailureLogged) return;
    pollFailureLogged = true;
    console.error("[deckos] Metrics polling failed:", error);
  }
}

/**
 * Polling exists only to feed subscribers, so its lifetime is refcounted on the
 * subscriber set: started on the 0->1 transition and stopped on 1->0. Starting
 * it with nobody listening would leak a 2-second collector for the lifetime of
 * the process, which is exactly what an SSE handler that started the poller up
 * front and then failed before reaching `subscribeToMetrics()` used to do.
 */
function syncPollingWithSubscribers(): void {
  if (metricsSubscribers.size === 0) {
    stopMetricsPolling();
    return;
  }
  if (pollInterval) return;

  void runPollCycle();
  pollInterval = setInterval(() => {
    void runPollCycle();
  }, POLL_INTERVAL_MS);
}

export function stopMetricsPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  // Once collection stops the gap to the next sample is unbounded, so every
  // carried-over sample is dropped and re-taken on resume. It matters most for
  // the RAPL counter, which wraps at `max_energy_range_uj` and would otherwise
  // yield a silently wrong delta measured across the gap.
  lastCpuEnergyUj = null;
  lastCpuEnergyAtMs = null;
  lastProcessMetrics = null;
  lastProcessSampleAtMs = null;
}

export function getCachedMetrics(): SystemMetrics | null {
  return cachedMetrics;
}

export function getMetricsHistory(): SystemMetrics[] {
  return metricsHistory;
}

export function subscribeToMetrics(
  callback: (metrics: SystemMetrics) => void
): () => void {
  metricsSubscribers.add(callback);
  // Refcounted start: the first subscriber turns the poller on, so no caller has
  // to remember to, and one that fails before subscribing cannot leave it running.
  syncPollingWithSubscribers();

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    metricsSubscribers.delete(callback);
    // Nothing is listening any more; stop paying for collection until the next
    // dashboard connects.
    syncPollingWithSubscribers();
  };
}

export async function getOneShotMetrics(): Promise<SystemMetrics> {
  return await collectMetrics();
}

/**
 * Read path for queries: serve the poller's cache when it is fresh, otherwise
 * collect once. Never touches history or subscribers.
 */
export async function getMetricsSnapshot(): Promise<SystemMetrics> {
  if (
    cachedMetrics !== null &&
    cachedMetricsAtMs !== null &&
    Date.now() - cachedMetricsAtMs <= CACHED_METRICS_MAX_AGE_MS
  ) {
    return cachedMetrics;
  }
  return await collectMetrics();
}
