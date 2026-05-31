import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "../../stores/connection";
import { useToastStore } from "../../stores/toast";
import { TopBar } from "./TopBar";

const {
  useQueryMock,
  useMutationMock,
  useRouterStateMock,
  powerActionMutateMock,
  trpcClientMock,
  useTRPCMock,
} = vi.hoisted(() => {
  const powerActionMutate = vi.fn();
  return {
    useQueryMock: vi.fn(),
    useMutationMock: vi.fn(),
    useRouterStateMock: vi.fn(),
    powerActionMutateMock: powerActionMutate,
    trpcClientMock: {
      system: {
        powerAction: {
          mutate: (...args: unknown[]) => powerActionMutate(...args),
        },
      },
    },
    useTRPCMock: vi.fn(() => ({
      system: {
        getInfo: {
          queryOptions: vi.fn(() => ({ queryKey: ["system", "getInfo"] })),
        },
        getUpdateStatus: {
          queryOptions: vi.fn(() => ({ queryKey: ["system", "getUpdateStatus"] })),
        },
      },
    })),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    onClick,
    activeProps: _activeProps,
    ...rest
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: () => void;
    activeProps?: unknown;
  }) => (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
  useRouterState: (...args: unknown[]) => useRouterStateMock(...args),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (arg: unknown) => useQueryMock(arg),
  useMutation: (arg: unknown) => useMutationMock(arg),
}));

vi.mock("../../trpc", () => ({
  trpcClient: trpcClientMock,
  useTRPC: () => useTRPCMock(),
}));

vi.mock("../../hooks/useApiHealth", () => ({
  useApiHealth: vi.fn(),
}));

describe("TopBar", () => {
  const mockTopBarQueries = (updateAvailable: boolean) => {
    useQueryMock.mockImplementation((query: { queryKey?: string[] }) => {
      if (query.queryKey?.includes("getInfo")) {
        return { data: { hostname: "LAB-HOST" } };
      }
      return { data: { updateAvailable } };
    });
  };

  beforeEach(() => {
    useQueryMock.mockReset();
    useMutationMock.mockReset();
    useRouterStateMock.mockReset();
    powerActionMutateMock.mockReset();
    useTRPCMock.mockClear();
    useRouterStateMock.mockReturnValue("/");

    useConnectionStore.setState({
      connections: {
        api: { connected: true, lastConnectedAt: 1, attemptCount: 0 },
        metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
        logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      },
    });
  });

  it("renders hostname and update marker from query data", () => {
    mockTopBarQueries(true);
    useMutationMock.mockReturnValue({ mutate: vi.fn() });

    render(<TopBar authEnabled={false} onLock={vi.fn()} />);

    expect(screen.getByText("LAB-HOST")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "UPDATE" })).toBeInTheDocument();
  });

  it("calls onLock when lock trigger is clicked", async () => {
    const user = userEvent.setup();
    const onLock = vi.fn().mockResolvedValue(undefined);
    mockTopBarQueries(false);
    useMutationMock.mockReturnValue({ mutate: vi.fn() });

    render(<TopBar authEnabled onLock={onLock} />);
    await user.click(screen.getByRole("button", { name: "Lock session" }));

    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("opens power confirmation and triggers restart mutate on confirm", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockTopBarQueries(false);
    useMutationMock.mockReturnValue({ mutate });

    render(<TopBar authEnabled={false} onLock={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Power menu" }));
    await user.click(screen.getByRole("menuitem", { name: "RESTART" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Confirm Restart")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "RESTART" }));
    expect(mutate).toHaveBeenCalledWith("restart");
  });

  it("shows restart success toast message from mutation callback", () => {
    const addToast = vi.fn();
    useToastStore.setState({
      toasts: [],
      addToast,
      removeToast: useToastStore.getState().removeToast,
    });

    let onSuccess: ((result: { action: "restart" | "shutdown" }) => void) | undefined;
    useMutationMock.mockImplementation((options: { onSuccess?: typeof onSuccess }) => {
      onSuccess = options.onSuccess;
      return { mutate: vi.fn() };
    });
    mockTopBarQueries(false);

    render(<TopBar authEnabled={false} onLock={vi.fn()} />);

    onSuccess?.({ action: "restart" });
    expect(addToast).toHaveBeenCalledWith("System restart requested", "info");
  });
});
