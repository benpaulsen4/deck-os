import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../apps/new";

const { deleteSpy, addToastSpy } = vi.hoisted(() => ({
  deleteSpy: vi.fn(async () => ({})),
  addToastSpy: vi.fn(),
}));
const { navigateSpy, startSpy } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  startSpy: vi.fn(async () => ({})),
}));
const { validateSpy } = vi.hoisted(() => ({
  validateSpy: vi.fn(),
}));

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: (props: { children: unknown }) => <span>{props.children as string}</span>,
  };
});

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../trpc", () => ({
  trpcClient: {
    apps: {
      create: { mutate: vi.fn(async () => ({ id: "app-new" })) },
      delete: { mutate: deleteSpy },
      validateCompose: { mutate: validateSpy },
    },
    docker: {
      start: { mutate: startSpy },
    },
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (opts: {
    mutationFn: (...args: unknown[]) => Promise<unknown>;
    onSuccess?: (...args: unknown[]) => void;
  }) => ({
    isPending: false,
    mutate: async (...args: unknown[]) => {
      const result = await opts.mutationFn(...args);
      opts.onSuccess?.(result, ...args);
    },
  }),
}));

vi.mock("../../components/ui/CodeEditor", () => ({
  CodeEditor: (props: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="compose"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
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

function getRouteComponent() {
  const component = Route.options.component;
  if (!component) {
    throw new Error("Route component is not defined");
  }
  return component;
}

describe("apps new route", () => {
  beforeEach(() => {
    deleteSpy.mockReset();
    addToastSpy.mockReset();
    navigateSpy.mockReset();
    startSpy.mockReset();
    validateSpy.mockReset();
  });

  it("disables create when required fields missing", () => {
    const Component = getRouteComponent();
    render(<Component />);
    expect(screen.getByRole("button", { name: "CREATE & DEPLOY" })).toBeDisabled();
  });

  it("rolls back app on pull failure", async () => {
    const Component = getRouteComponent();
    render(<Component />);
    fireEvent.change(screen.getByLabelText("APP NAME"), { target: { value: "My App" } });
    fireEvent.click(screen.getByRole("button", { name: "CREATE & DEPLOY" }));
    fireEvent.click(await screen.findByText("FAIL_PULL"));
    expect(deleteSpy).toHaveBeenCalledWith({ id: "app-new" });
    await waitFor(() => expect(addToastSpy).toHaveBeenCalled());
  });

  it("navigates to app detail after successful create pull and deploy", async () => {
    const Component = getRouteComponent();
    render(<Component />);
    fireEvent.change(screen.getByLabelText("APP NAME"), { target: { value: "My App" } });
    fireEvent.click(screen.getByRole("button", { name: "CREATE & DEPLOY" }));
    fireEvent.click(await screen.findByText("SUCCESS_PULL"));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({
        to: "/apps/$appId",
        params: { appId: "app-new" },
      })
    );
    expect(startSpy).toHaveBeenCalledWith({ appId: "app-new" });
  });

  describe("validate button", () => {
    function clickValidate() {
      const Component = getRouteComponent();
      render(<Component />);
      fireEvent.click(screen.getByRole("button", { name: "VALIDATE" }));
    }

    it("confirms a valid file", async () => {
      validateSpy.mockResolvedValue({ valid: true, message: "Compose YAML is valid" });
      clickValidate();
      await waitFor(() =>
        expect(addToastSpy).toHaveBeenCalledWith("Compose YAML is valid", "success")
      );
      expect(screen.queryByText("Compose YAML is valid")).not.toBeInTheDocument();
    });

    it("shows why a file was reported invalid", async () => {
      validateSpy.mockResolvedValue({
        valid: false,
        message: "Compose YAML took too long to parse",
      });
      clickValidate();
      expect(
        await screen.findByText("Compose YAML took too long to parse")
      ).toBeInTheDocument();
      expect(addToastSpy).toHaveBeenCalledWith("Validation failed", "error");
    });

    it("shows why a file was refused outright", async () => {
      validateSpy.mockRejectedValue(new Error("Compose YAML must be 512 KiB or smaller"));
      clickValidate();
      expect(
        await screen.findByText("Compose YAML must be 512 KiB or smaller")
      ).toBeInTheDocument();
      expect(addToastSpy).toHaveBeenCalledWith("Validation failed", "error");
    });

    it("clears the previous error once the file is valid", async () => {
      validateSpy.mockResolvedValueOnce({ valid: false, message: "Missing services" });
      clickValidate();
      await screen.findByText("Missing services");

      validateSpy.mockResolvedValueOnce({
        valid: true,
        message: "Compose YAML is valid",
      });
      fireEvent.click(screen.getByRole("button", { name: "VALIDATE" }));
      await waitFor(() =>
        expect(screen.queryByText("Missing services")).not.toBeInTheDocument()
      );
    });
  });
});
