import { create } from "zustand";
import type { SystemMetrics } from "../../../server/src/lib/schema.js";

interface MetricsState {
  metrics: SystemMetrics | null;
  history: SystemMetrics[];
  isConnected: boolean;
  setMetrics: (metrics: SystemMetrics) => void;
  setConnected: (connected: boolean) => void;
  getHistory: (count?: number) => SystemMetrics[];
}

const HISTORY_SIZE = 60;

export const useMetricsStore = create<MetricsState>((set, get) => ({
  metrics: null,
  history: [],
  isConnected: false,

  setMetrics: (metrics) => {
    set({
      metrics,
      history: [...get().history, metrics].slice(-HISTORY_SIZE),
    });
  },

  setConnected: (connected) => {
    set({ isConnected: connected });
  },

  getHistory: (count = HISTORY_SIZE) => {
    return get().history.slice(-count);
  },
}));