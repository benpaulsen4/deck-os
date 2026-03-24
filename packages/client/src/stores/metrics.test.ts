import { beforeEach, describe, expect, it } from "vitest";
import { useMetricsStore } from "./metrics";
import { METRICS_HISTORY_SIZE } from "../lib/constants";

function metricAt(index: number) {
  return {
    cpu: { usage: index, load: [index], cores: 4, speed: 2.1, temperatureC: null, powerWatts: null },
    memory: {
      total: 1000,
      used: 100 + index,
      free: 900 - index,
      usage: 10 + index,
      swapTotal: 0,
      swapUsed: 0,
      swapFree: 0,
      swapUsage: 0,
    },
    processes: { all: 100, running: 2, blocked: 0, sleeping: 98 },
    disk: { fs: [{ fs: "/dev/sda", mount: "/", size: 1000, used: 100, usePercent: 10 }] },
    network: { interfaces: { eth0: { rx_bytes: 1, tx_bytes: 2, rx_sec: 0.1, tx_sec: 0.2 } } },
    timestamp: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  };
}

describe("useMetricsStore", () => {
  beforeEach(() => {
    useMetricsStore.setState({
      metrics: null,
      history: [],
      isConnected: false,
    });
  });

  it("stores the latest metrics and keeps history bounded", () => {
    const store = useMetricsStore.getState();

    for (let i = 0; i < METRICS_HISTORY_SIZE + 5; i += 1) {
      store.setMetrics(metricAt(i));
    }

    expect(useMetricsStore.getState().metrics).toEqual(metricAt(METRICS_HISTORY_SIZE + 4));
    expect(useMetricsStore.getState().history).toHaveLength(METRICS_HISTORY_SIZE);
    expect(useMetricsStore.getState().history[0]?.cpu.usage).toBe(5);
  });

  it("returns recent history slices and tracks connected state", () => {
    const store = useMetricsStore.getState();
    store.setMetrics(metricAt(1));
    store.setMetrics(metricAt(2));
    store.setMetrics(metricAt(3));
    store.setConnected(true);

    expect(store.getHistory(2).map((item) => item.cpu.usage)).toEqual([2, 3]);
    expect(useMetricsStore.getState().isConnected).toBe(true);
  });
});
