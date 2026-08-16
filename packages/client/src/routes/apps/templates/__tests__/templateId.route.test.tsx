import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithAppRouter } from "../../../../test/helpers/router";

type TemplateFixture = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  composeTemplate?: string;
  parameters: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    options?: string[];
    defaultValue?: string;
  }>;
  webUrlTemplate?: string;
};

// The buggy effect calls setParams with a brand-new {} on every run (params
// is empty, so `!Object.keys(params).length` never becomes false), and the
// resulting identity change re-triggers the effect via its own dependency
// array. Each cycle re-renders the component, so `useQuery` -- read once per
// render -- gets called again and again. React's own passive-effect
// scheduler drains this over real macrotask turns rather than inside a
// single synchronous act() flush, so `findByText` resolving on the very
// first render (the title comes straight from `tpl`, before the effect ever
// runs) proves nothing about the loop. A component that seeds correctly
// settles in a handful of renders; the buggy one reaches into the hundreds
// within milliseconds. This threshold sits far enough above a normal
// settle count, and far enough below the observed runaway count, that it
// fails loudly and specifically instead of timing out ambiguously.
const RENDER_LOOP_THRESHOLD = 30;

const { state, templateGetCallCount } = vi.hoisted(() => ({
  state: {
    template: null as TemplateFixture | null,
  },
  templateGetCallCount: { current: 0 },
}));

vi.mock("../../../../trpc", () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTRPC: () => ({
    templates: {
      get: {
        queryOptions: (input?: { id?: string }) => ({
          queryKey: ["template.get", input?.id ?? ""],
        }),
      },
    },
  }),
  trpcClient: {
    templates: {
      deploy: { mutate: vi.fn(async () => ({ id: "app1" })) },
    },
    apps: {
      delete: { mutate: vi.fn(async () => ({})) },
    },
    docker: {
      start: { mutate: vi.fn(async () => ({})) },
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (arg: unknown) => {
      const maybe = arg as { queryKey?: unknown[] };
      const key = maybe.queryKey?.[0];
      if (key === "template.get") {
        templateGetCallCount.current += 1;
        return { data: state.template, isLoading: false, error: null };
      }
      return { data: null, isLoading: false, error: null };
    },
  };
});

vi.mock("../../../../stores/toast", () => ({
  useToastStore: () => ({ toasts: [], addToast: vi.fn(), removeToast: vi.fn() }),
}));

vi.mock("../../../../components/ui/PullProgress", () => ({
  PullProgress: () => null,
}));

// The root route renders TopBar + useAppStatus/useAuthGate, which query
// tRPC namespaces this test's minimal useTRPC mock doesn't provide. Stub
// them out the same way files.route.test.tsx does, since we only care
// about the template detail route rendered under the app shell.
vi.mock("../../../../hooks/useAuthGate", () => ({
  useAuthGate: () => ({
    authChecking: false,
    authEnabled: false,
    authUnlocked: true,
    pin: "",
    setPin: vi.fn(),
    unlockError: null,
    unlocking: false,
    retryAfterMs: null,
    handleUnlock: vi.fn(async () => {}),
    handleLock: vi.fn(),
  }),
}));

vi.mock("../../../../hooks/useAppStatus", () => ({
  useAppStatus: vi.fn(),
}));

vi.mock("../../../../components/layout/TopBar", () => ({
  TopBar: () => <div>TOP_BAR</div>,
}));

describe("template detail route seeding", () => {
  beforeEach(() => {
    templateGetCallCount.current = 0;
  });

  it("renders a template with no parameters without looping", async () => {
    // Exactly one of the 158 shipped templates -- playit-agent -- has an
    // empty parameters array. `params` is in the effect's dependency array
    // and the effect calls setParams with a brand-new {} whenever params is
    // empty, so the identity change re-triggers it forever.
    state.template = {
      id: "playit-agent",
      title: "Playit Agent",
      description: "A free reverse proxy for tunneling services (not self-hosted).",
      icon: "",
      composeTemplate: "services:\n  app:\n    image: playit/agent",
      parameters: [],
      webUrlTemplate: "",
    };

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithAppRouter({ initialEntries: ["/apps/templates/playit-agent"] });
    expect(await screen.findByText("Playit Agent")).toBeInTheDocument();

    // The title renders on the very first pass, straight from `tpl` --
    // that assertion alone would pass even with the loop running, since the
    // loop only starts once the seeding effect fires post-commit. Give the
    // scheduler real time to drain any cascading passive-effect updates
    // before checking whether the render count ran away.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(templateGetCallCount.current).toBeLessThan(RENDER_LOOP_THRESHOLD);
    expect(
      consoleErrorSpy.mock.calls.some(([message]) =>
        String(message).includes("Maximum update depth")
      )
    ).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("lets the app name be cleared and retyped", async () => {
    // The effect seeds name/description/icon/url only when falsy, but those
    // are its own dependencies -- so clearing APP NAME re-runs it and
    // immediately writes the template title back. The field cannot be
    // emptied. Plex carries a real parameter (unlike playit-agent above) so
    // this test exercises only CLI-3, not the CLI-2 empty-params loop.
    state.template = {
      id: "plex",
      title: "Plex",
      description: "Media server",
      icon: "",
      composeTemplate: "services:\n  app:\n    image: plexinc/pms-docker",
      parameters: [{ key: "PORT", label: "Port", type: "port", defaultValue: "32400" }],
      webUrlTemplate: "http://{{DECKOS_HOST}}:{{PORT}}",
    };

    renderWithAppRouter({ initialEntries: ["/apps/templates/plex"] });

    const nameInput = (await screen.findByLabelText(/app name/i)) as HTMLInputElement;
    expect(nameInput.value).toBe("Plex");

    fireEvent.change(nameInput, { target: { value: "" } });

    expect(nameInput.value).toBe("");
  });
});
