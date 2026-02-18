import { create } from "zustand";

export type AppStatus =
  | "running"
  | "stopped"
  | "restarting"
  | "warning"
  | "pulling"
  | "unknown";

export interface AppStatusState {
  appStatuses: Record<string, AppStatus>;
  flashStates: Record<string, boolean>;
  setAppStatus: (appId: string, status: AppStatus) => void;
  triggerFlash: (appId: string) => void;
  clearFlash: (appId: string) => void;
  getAppStatus: (appId: string) => AppStatus;
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  appStatuses: {},
  flashStates: {},
  setAppStatus: (appId: string, status: AppStatus) => {
    set((state) => ({
      appStatuses: { ...state.appStatuses, [appId]: status },
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
}));
