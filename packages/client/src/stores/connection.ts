import { create } from "zustand";

export type ConnectionType = "api" | "metrics" | "events" | "logs";

export interface ConnectionState {
  connected: boolean;
  lastConnectedAt: number | null;
  attemptCount: number;
}

interface ConnectionsState {
  connections: Record<ConnectionType, ConnectionState>;
  setConnected: (type: ConnectionType, connected: boolean) => void;
  getConnectionStatus: (type: ConnectionType) => ConnectionState;
  getAnyConnected: () => boolean;
}

const initialState: ConnectionState = {
  connected: false,
  lastConnectedAt: null,
  attemptCount: 0,
};

export const useConnectionStore = create<ConnectionsState>((set, get) => ({
  connections: {
    api: { ...initialState },
    metrics: { ...initialState },
    events: { ...initialState },
    logs: { ...initialState },
  },

  setConnected: (type, connected) => {
    set((state) => ({
      connections: {
        ...state.connections,
        [type]: {
          connected,
          lastConnectedAt: connected
            ? Date.now()
            : state.connections[type].lastConnectedAt,
          attemptCount: connected ? 0 : state.connections[type].attemptCount + 1,
        },
      },
    }));
  },

  getConnectionStatus: (type) => get().connections[type],

  getAnyConnected: () => {
    const connections = get().connections;
    return Object.values(connections).some((c) => c.connected);
  },
}));
