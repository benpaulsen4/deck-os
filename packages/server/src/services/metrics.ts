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
const metricsSubscribers: Set<(metrics: SystemMetrics) => void> = new Set();
let pollInterval: NodeJS.Timeout | null = null;
const metricsHistory: SystemMetrics[] = [];

let raplEnergyPath: string | null | undefined = undefined;
let raplMaxEnergyRangeUj: number | null = null;
let lastRaplDiscoveryAtMs = 0;
let lastCpuEnergyUj: number | null = null;
let lastCpuEnergyAtMs: number | null = null;
const RAPL_REDISCOVERY_INTERVAL_MS = 60_000;

async function readNumberFromFile(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, "utf8");
    const value = Number.parseFloat(raw.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
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

async function discoverRaplEnergyPath(nowMs: number): Promise<void> {
  lastRaplDiscoveryAtMs = nowMs;
  raplEnergyPath = await findRaplEnergyPath();
  raplMaxEnergyRangeUj = null;
  if (!raplEnergyPath) return;
  const maxRangePath = join(dirname(raplEnergyPath), "max_energy_range_uj");
  raplMaxEnergyRangeUj = await readNumberFromFile(maxRangePath);
}

async function readCpuPowerWatts(nowMs: number): Promise<number | null> {
  if (process.platform !== "linux") return null;

  if (
    raplEnergyPath === undefined ||
    (raplEnergyPath === null && nowMs - lastRaplDiscoveryAtMs >= RAPL_REDISCOVERY_INTERVAL_MS)
  ) {
    await discoverRaplEnergyPath(nowMs);
  }
  if (!raplEnergyPath) return null;

  const energyUj = await readNumberFromFile(raplEnergyPath);
  if (energyUj === null) {
    raplEnergyPath = null;
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
  const processes = await si.processes();
  return {
    all: processes.all,
    running: processes.running,
    blocked: processes.blocked,
    sleeping: processes.sleeping,
  };
}

async function collectDiskMetrics(): Promise<DiskMetrics> {
  const fsSize = await si.fsSize();
  const realFileSystems = fsSize.filter((fs) => {
    const fsType = (fs.type || "").toLowerCase();
    if (fsType === "tmpfs" || fsType === "swap") return false;
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

async function collectMetrics(): Promise<SystemMetrics> {
  const [cpu, memory, processes, disk, network] = await Promise.all([
    collectCPUMetrics(),
    collectMemoryMetrics(),
    collectProcessMetrics(),
    collectDiskMetrics(),
    collectNetworkMetrics(),
  ]);

  const metrics: SystemMetrics = {
    cpu,
    memory,
    processes,
    disk,
    network,
    timestamp: new Date().toISOString(),
  };

  cachedMetrics = metrics;
  metricsHistory.push(metrics);
  if (metricsHistory.length > METRICS_HISTORY_SIZE) {
    metricsHistory.shift();
  }

  metricsSubscribers.forEach((subscriber) => {
    subscriber(metrics);
  });

  return metrics;
}

export function startMetricsPolling(): void {
  if (pollInterval) return;
  collectMetrics();
  pollInterval = setInterval(collectMetrics, POLL_INTERVAL_MS);
}

export function stopMetricsPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
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
  return () => metricsSubscribers.delete(callback);
}

export async function getOneShotMetrics(): Promise<SystemMetrics> {
  return await collectMetrics();
}
