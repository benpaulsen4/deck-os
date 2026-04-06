import { fireEvent, render, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../settings";

const { addToastSpy, authFetchSpy, emitUnauthorizedEventSpy, checkForUpdatesSpy } =
  vi.hoisted(() => ({
  addToastSpy: vi.fn(),
  authFetchSpy: vi.fn(),
  emitUnauthorizedEventSpy: vi.fn(),
  checkForUpdatesSpy: vi.fn(async () => ({ updateAvailable: false })),
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    system: {
      getInfo: { queryOptions: () => ({ queryKey: ["system.getInfo"] }) },
      getDataDir: { queryOptions: () => ({ queryKey: ["system.getDataDir"] }) },
      getMetrics: { queryOptions: () => ({ queryKey: ["system.getMetrics"] }) },
      getUpdateStatus: { queryOptions: () => ({ queryKey: ["system.getUpdateStatus"] }) },
    },
  }),
  trpcClient: {
    system: {
      checkForUpdates: { mutate: checkForUpdatesSpy },
      applyUpdate: { mutate: vi.fn(async () => ({ ok: true })) },
    },
  },
}));

vi.mock("../../lib/auth", () => ({
  authFetch: authFetchSpy,
  emitUnauthorizedEvent: emitUnauthorizedEventSpy,
  fetchAuthStatus: vi.fn(async () => ({ enabled: false, sessionDurationMs: 86_400_000 })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(async () => {}),
    setQueryData: vi.fn(),
  }),
  useMutation: (opts: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: (...args: unknown[]) => void;
  }) => ({
    isPending: false,
    mutate: async (...args: unknown[]) => {
      const value = await opts.mutationFn(...args);
      opts.onSuccess?.(value ?? { updateAvailable: false }, ...args);
    },
  }),
  useQuery: (arg: unknown) => {
    const maybe = arg as { queryKey?: string[] };
    if (Array.isArray(maybe?.queryKey) && maybe.queryKey[0] === "auth-status") {
      return {
        data: { enabled: false, sessionDurationMs: 86_400_000 },
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(async () => ({})),
      };
    }
    return {
      data: null,
      isLoading: false,
      isFetching: false,
    };
  },
}));

describe("settings route", () => {
  beforeEach(() => {
    addToastSpy.mockReset();
    authFetchSpy.mockReset();
    emitUnauthorizedEventSpy.mockReset();
    checkForUpdatesSpy.mockReset();
    checkForUpdatesSpy.mockResolvedValue({ updateAvailable: false });
    authFetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  it("blocks invalid passcode before auth API call", () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getAllByRole("button", { name: "ENABLE PASSCODE" })[0]);
    fireEvent.change(screen.getByLabelText("NEW PASSCODE"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("CONFIRM PASSCODE"), { target: { value: "12" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ENABLE PASSCODE" })[1]);
    expect(addToastSpy).toHaveBeenCalledWith("Passcode must be 4-10 digits", "error");
    expect(authFetchSpy).not.toHaveBeenCalled();
  });

  it("emits unauthorized lock event after successful security actions", async () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getAllByRole("button", { name: "ENABLE PASSCODE" })[0]);
    fireEvent.change(screen.getByLabelText("NEW PASSCODE"), { target: { value: "1234" } });
    fireEvent.change(screen.getByLabelText("CONFIRM PASSCODE"), { target: { value: "1234" } });
    fireEvent.click(screen.getAllByRole("button", { name: "ENABLE PASSCODE" })[1]);
    await waitFor(() => expect(emitUnauthorizedEventSpy).toHaveBeenCalled());
  });

  it("shows correct update check and apply status transitions", async () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "CHECK NOW" }));
    await waitFor(() => expect(checkForUpdatesSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith("No updates available", "info")
    );
  });
});
