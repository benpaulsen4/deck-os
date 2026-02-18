import { create } from "zustand";
import type { SystemMetrics } from "../../../server/src/lib/schema.js";
import { METRICS_HISTORY_SIZE } from "../lib/constants.js";

interface MetricsState {
  metrics: SystemMetrics | null;
  history: SystemMetrics[];
  isConnected: boolean;
  setMetrics: (metrics: SystemMetrics) => void;
  setConnected: (connected: boolean) => void;
  getHistory: (count?: number) => SystemMetrics[];
}

export const useMetricsStore = create<MetricsState>((set, get) => ({
  metrics: null,
  history: [],
  isConnected: false,

  setMetrics: (metrics) => {
    set({
      metrics,
      history: [...get().history, metrics].slice(-METRICS_HISTORY_SIZE),
    });
  },

  setConnected: (connected) => {
    set({ isConnected: connected });
  },

  getHistory: (count = METRICS_HISTORY_SIZE) => {
    return get().history.slice(-count);
  },
}));
