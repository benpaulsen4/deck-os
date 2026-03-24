import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStatus } from "./useAppStatus";
import { useAppStatusStore } from "../stores/appStatus";

const {
  useQueryMock,
  useTRPCMock,
  useDockerEventsMock,
  getStatusesQueryMock,
  dockerEventBridge,
} = vi.hoisted(() => {
  let dockerCallback: ((event: unknown) => void) | null = null;
  return {
    useQueryMock: vi.fn(),
    useTRPCMock: vi.fn(),
    useDockerEventsMock: vi.fn<
      (callback: (event: unknown) => void, options?: { enabled?: boolean }) => void
    >((callback) => {
      dockerCallback = callback;
    }),
    getStatusesQueryMock: vi.fn(),
    dockerEventBridge: {
      emit(event: unknown) {
        dockerCallback?.(event);
      },
      reset() {
        dockerCallback = null;
      },
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("./useDockerEvents", () => ({
  useDockerEvents: useDockerEventsMock,
}));

vi.mock("../trpc", () => ({
  useTRPC: (...args: unknown[]) => useTRPCMock(...args),
  trpcClient: {
    docker: {
      getStatuses: {
        query: (...args: unknown[]) => getStatusesQueryMock(...args),
      },
    },
  },
}));

describe("useAppStatus", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useTRPCMock.mockReset();
    useDockerEventsMock.mockClear();
    getStatusesQueryMock.mockReset();
    dockerEventBridge.reset();
    useAppStatusStore.setState({
      appStatuses: {},
      stackStatuses: {},
      flashStates: {},
    });
    useTRPCMock.mockReturnValue({
      apps: {
        list: {
          queryOptions: vi.fn(() => ({ queryKey: ["apps-list"] })),
        },
      },
    });
  });

  it("sets batch stack statuses from query results", async () => {
    useQueryMock
      .mockReturnValueOnce({ data: [{ id: "app-1" }, { id: "app-2" }] })
      .mockReturnValueOnce({
        data: {
          statuses: {
            "app-1": { running: 1, stopped: 0, restarting: 0, containers: [] },
            "app-2": { running: 0, stopped: 1, restarting: 0, containers: [] },
          },
        },
      });

    renderHook(() => useAppStatus());

    await waitFor(() => {
      expect(useAppStatusStore.getState().stackStatuses).toEqual({
        "app-1": { running: 1, stopped: 0, restarting: 0, containers: [] },
        "app-2": { running: 0, stopped: 1, restarting: 0, containers: [] },
      });
    });
  });

  it("clears stack statuses when apps list is empty", async () => {
    useAppStatusStore.setState({
      stackStatuses: {
        old: { running: 1, stopped: 0, restarting: 0, containers: [] },
      },
    });
    useQueryMock.mockReturnValueOnce({ data: [] }).mockReturnValueOnce({ data: undefined });

    renderHook(() => useAppStatus());

    await waitFor(() => {
      expect(useAppStatusStore.getState().stackStatuses).toEqual({});
    });
  });

  it("maps docker events into app statuses for deckos projects", async () => {
    useQueryMock.mockReturnValueOnce({ data: [] }).mockReturnValueOnce({ data: undefined });

    const { result } = renderHook(() => useAppStatus());

    act(() => {
      dockerEventBridge.emit({
        Type: "container",
        Action: "start",
        Actor: {
          ID: "id-1",
          Attributes: {
            "com.docker.compose.project": "deckos-my-app",
            name: "deckos-my-app-container-1",
          },
        },
        time: 1,
        timeNano: 1,
      });
    });

    expect(result.current.getAppStatus("my-app")).toBe("running");
    expect(result.current.getResolvedStatus("my-app")).toBe("running");
    expect(useAppStatusStore.getState().flashStates["my-app"]).toBe(true);
  });

  it("forwards enabled flag to docker events and ignores updates when disabled", async () => {
    useQueryMock.mockReturnValueOnce({ data: [] }).mockReturnValueOnce({ data: undefined });

    const { result } = renderHook(() => useAppStatus({ enabled: false }));

    const options = useDockerEventsMock.mock.calls[0]?.[1] as { enabled?: boolean } | undefined;
    expect(options).toEqual({ enabled: false });

    act(() => {
      dockerEventBridge.emit({
        Type: "container",
        Action: "start",
        Actor: {
          ID: "id-1",
          Attributes: {
            "com.docker.compose.project": "deckos-disabled",
            name: "deckos-disabled-container-1",
          },
        },
        time: 1,
        timeNano: 1,
      });
    });

    expect(result.current.getAppStatus("disabled")).toBe("unknown");
  });
});
