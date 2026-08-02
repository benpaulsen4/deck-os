import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SystemInfoBar } from "./SystemInfoBar";

const getStatusesMock = vi.fn();

const systemInfo = {
  hostname: "deckos",
  os: "Linux",
  osDistro: "Debian",
  osRelease: "12",
  uptime: 3600,
  dockerVersion: "27.0.0",
};

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    system: {
      getInfo: {
        queryOptions: () => ({
          queryKey: ["system.getInfo"],
          queryFn: async () => systemInfo,
        }),
      },
    },
    apps: {
      list: {
        queryOptions: () => ({
          queryKey: ["apps.list"],
          queryFn: async () => [{ id: "alpha" }, { id: "beta" }],
        }),
      },
    },
  }),
  trpcClient: {
    docker: {
      getStatuses: {
        query: (...args: unknown[]) => getStatusesMock(...args),
      },
    },
  },
}));

let queryClient: QueryClient;

function renderBar(children = <SystemInfoBar />) {
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("SystemInfoBar", () => {
  beforeEach(() => {
    getStatusesMock.mockReset();
    getStatusesMock.mockResolvedValue({
      statuses: {
        alpha: { running: 2, stopped: 1 },
        beta: { running: 1, stopped: 0 },
      },
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  // CLI-8: the bar used a private key, so React Query could not dedupe it against
  // `useAppStatus` and every `invalidateStatusQueries` call missed it.
  it("polls stack status under the shared cache key", async () => {
    renderBar();

    await waitFor(() => {
      expect(getStatusesMock).toHaveBeenCalled();
    });

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(["stackStatusBatch", ["alpha", "beta"]]);
    expect(
      keys.some((key) => String(key[0]).startsWith("systemInfoBarStackStatus"))
    ).toBe(false);
  });

  it("is invalidated by the shared stackStatusBatch prefix used after start/stop", async () => {
    renderBar();
    await waitFor(() => {
      expect(getStatusesMock).toHaveBeenCalledTimes(1);
    });

    await queryClient.invalidateQueries({ queryKey: ["stackStatusBatch"] });

    await waitFor(() => {
      expect(getStatusesMock).toHaveBeenCalledTimes(2);
    });
  });

  it("dedupes the poll when the bar and another consumer share the key", async () => {
    renderBar(
      <>
        <SystemInfoBar />
        <SystemInfoBar />
      </>
    );

    await waitFor(() => {
      expect(getStatusesMock).toHaveBeenCalled();
    });
    expect(getStatusesMock).toHaveBeenCalledTimes(1);
  });

  it("totals running and stopped containers", async () => {
    renderBar();

    expect(await screen.findByText("3 RUN / 1 STOP")).toBeInTheDocument();
  });
});
