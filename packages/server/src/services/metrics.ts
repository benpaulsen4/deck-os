import si from "systeminformation";
import type { SystemMetrics, CPUMetrics, MemoryMetrics, DiskMetrics, NetworkMetrics } from "../lib/schema.js";

let cachedMetrics: SystemMetrics | null = null;
let metricsSubscribers: Set<(metrics: SystemMetrics) => void> = new Set();
let pollInterval: NodeJS.Timeout | null = null;
let metricsHistory: SystemMetrics[] = [];

const POLL_INTERVAL = 2000;
const HISTORY_SIZE = 60;

async function collectCPUMetrics(): Promise<CPUMetrics> {
  const cpuLoad = await si.currentLoad();
  const cpu = await si.cpu();
  return {
    usage: cpuLoad.currentLoad,
    load: [cpuLoad.currentLoadUser, cpuLoad.currentLoadSystem, cpuLoad.currentLoadIdle],
    cores: cpu.cores,
    speed: cpu.speed,
  };
}

async function collectMemoryMetrics(): Promise<MemoryMetrics> {
  const mem = await si.mem();
  const total = mem.total;
  const used = mem.used;
  return {
    total,
    used,
    free: mem.free,
    usage: (used / total) * 100,
  };
}

async function collectDiskMetrics(): Promise<DiskMetrics> {
  const fsSize = await si.fsSize();
  return {
    fs: fsSize.map((fs) => ({
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
  const interfaces: Record<string, {
    rx_bytes: number;
    tx_bytes: number;
    rx_sec: number;
    tx_sec: number;
  }> = {};
  
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
  const [cpu, memory, disk, network] = await Promise.all([
    collectCPUMetrics(),
    collectMemoryMetrics(),
    collectDiskMetrics(),
    collectNetworkMetrics(),
  ]);

  const metrics: SystemMetrics = {
    cpu,
    memory,
    disk,
    network,
    timestamp: new Date().toISOString(),
  };

  cachedMetrics = metrics;
  metricsHistory.push(metrics);
  if (metricsHistory.length > HISTORY_SIZE) {
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
  pollInterval = setInterval(collectMetrics, POLL_INTERVAL);
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

export function subscribeToMetrics(callback: (metrics: SystemMetrics) => void): () => void {
  metricsSubscribers.add(callback);
  return () => metricsSubscribers.delete(callback);
}

export async function getOneShotMetrics(): Promise<SystemMetrics> {
  return await collectMetrics();
}