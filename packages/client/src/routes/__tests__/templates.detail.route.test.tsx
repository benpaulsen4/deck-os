import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/templates/$templateId";

const { navigateSpy, deploySpy, deleteSpy, startSpy, addToastSpy, state } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  deploySpy: vi.fn(async () => ({ id: "app1" })),
  deleteSpy: vi.fn(async () => ({})),
  startSpy: vi.fn(async () => ({})),
  addToastSpy: vi.fn(),
  state: {
    template: {
      id: "tpl-1",
      title: "Template One",
      description: "A template",
      icon: "",
      composeTemplate: "services:\n  app:\n    image: nginx",
      parameters: [{ key: "PORT", label: "Port", type: "port", defaultValue: "8080" }],
      webUrlTemplate: "http://{{DECKOS_HOST}}:{{PORT}}",
    },
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: (props: { children: unknown }) => <span>{props.children as string}</span>,
  };
});

vi.mock("../../trpc", () => ({
  useTRPC: () => ({
    templates: {
      get: {
        queryOptions: () => ({ queryKey: ["template.get"] }),
      },
    },
  }),
  trpcClient: {
    templates: {
      deploy: { mutate: deploySpy },
    },
    apps: {
      delete: { mutate: deleteSpy },
    },
    docker: {
      start: { mutate: startSpy },
    },
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.template, isLoading: false, error: null }),
  useMutation: (opts: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: (...args: unknown[]) => void;
    onError?: (...args: unknown[]) => void;
  }) => ({
    isPending: false,
    mutate: async (...args: unknown[]) => {
      try {
        const result = await opts.mutationFn(...args);
        opts.onSuccess?.(result, ...args);
      } catch (error) {
        opts.onError?.(error, ...args);
      }
    },
  }),
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../components/ui/PullProgress", () => ({
  PullProgress: (props: {
    isOpen: boolean;
    onComplete: (result: { ok: boolean; error?: string }) => void;
  }) =>
    props.isOpen ? (
      <>
        <button onClick={() => props.onComplete({ ok: false, error: "pull failed" })}>
          FAIL_PULL
        </button>
        <button onClick={() => props.onComplete({ ok: true })}>SUCCESS_PULL</button>
      </>
    ) : null,
}));

vi.mock("../../components/ui/CodeEditor", () => ({
  CodeEditor: (props: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="compose-editor"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

describe("template detail route", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    deploySpy.mockReset();
    deleteSpy.mockReset();
    startSpy.mockReset();
    addToastSpy.mockReset();
    vi.spyOn(Route, "useParams").mockReturnValue({ templateId: "tpl-1" } as never);
  });

  it("renders template detail shell", () => {
    const Component = Route.options.component;
    render(<Component />);
    expect(screen.getByText("Template One")).toBeInTheDocument();
    expect(screen.getByText("COMPOSE")).toBeInTheDocument();
    expect(screen.getByText("BACK")).toBeInTheDocument();
  });

  it("rolls back app creation on deploy-and-start failure", async () => {
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "DEPLOY & START" }));
    fireEvent.click(await screen.findByText("FAIL_PULL"));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ id: "app1" }));
    expect(addToastSpy).toHaveBeenCalled();
  });

  it("navigates directly in deploy-only mode", async () => {
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "DEPLOY" }));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: "/apps/$appId",
        params: { appId: "app1" },
      })
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("sends composeOverride only when editing is enabled", async () => {
    const Component = Route.options.component;
    render(<Component />);
    fireEvent.click(screen.getByRole("button", { name: "DEPLOY" }));
    await waitFor(() => expect(deploySpy).toHaveBeenCalledTimes(1));
    expect(deploySpy.mock.calls[0][0].composeOverride).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "EDIT COMPOSE" }));
    fireEvent.change(screen.getByLabelText("compose-editor"), {
      target: { value: "services:\n  app:\n    image: alpine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "DEPLOY" }));
    await waitFor(() => expect(deploySpy).toHaveBeenCalledTimes(2));
    expect(deploySpy.mock.calls[1][0].composeOverride).toContain("alpine");
  });
});
