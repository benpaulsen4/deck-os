import { create } from "zustand";
import type { StackStatus } from "../../../server/src/lib/schema.js";

export type AppStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "warning"
  | "pulling"
  | "unknown";

export interface AppStatusState {
  appStatuses: Record<string, AppStatus>;
  stackStatuses: Record<string, StackStatus | null>;
  flashStates: Record<string, boolean>;
  setAppStatus: (appId: string, status: AppStatus) => void;
  setStackStatuses: (statuses: Record<string, StackStatus | null>) => void;
  setStackStatus: (appId: string, status: StackStatus | null) => void;
  triggerFlash: (appId: string) => void;
  clearFlash: (appId: string) => void;
  getAppStatus: (appId: string) => AppStatus;
  getStackStatus: (appId: string) => StackStatus | null;
  getResolvedStatus: (appId: string) => AppStatus;
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  appStatuses: {},
  stackStatuses: {},
  flashStates: {},
  setAppStatus: (appId: string, status: AppStatus) => {
    set((state) => ({
      appStatuses: { ...state.appStatuses, [appId]: status },
    }));
  },
  setStackStatuses: (statuses: Record<string, StackStatus | null>) => {
    set({ stackStatuses: statuses });
  },
  setStackStatus: (appId: string, status: StackStatus | null) => {
    set((state) => ({
      stackStatuses: { ...state.stackStatuses, [appId]: status },
    }));
  },
  triggerFlash: (appId: string) => {
    set((state) => ({
      flashStates: { ...state.flashStates, [appId]: true },
    }));
    setTimeout(() => {
      const store = get();
      store.clearFlash(appId);
    }, 200);
  },
  clearFlash: (appId: string) => {
    set((state) => {
      const newFlashStates = { ...state.flashStates };
      delete newFlashStates[appId];
      return { flashStates: newFlashStates };
    });
  },
  getAppStatus: (appId: string): AppStatus => {
    return get().appStatuses[appId] || "unknown";
  },
  getStackStatus: (appId: string): StackStatus | null => {
    return get().stackStatuses[appId] ?? null;
  },
  getResolvedStatus: (appId: string): AppStatus => {
    const liveStatus = get().appStatuses[appId];
    if (liveStatus && liveStatus !== "unknown") {
      return liveStatus;
    }
    const stackStatus = get().stackStatuses[appId];
    if (!stackStatus) {
      return "unknown";
    }
    if (stackStatus.running > 0) {
      return "running";
    }
    if (stackStatus.restarting > 0) {
      return "restarting";
    }
    if (stackStatus.stopped > 0 || (stackStatus.containers?.length ?? 0) === 0) {
      return "stopped";
    }
    return "unknown";
  },
}));
