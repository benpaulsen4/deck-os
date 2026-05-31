import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithAppRouter } from "../../test/helpers/router";

type MockDirectoryListing = {
  cwd: string;
  parent: string | null;
  entries: Array<{
    name: string;
    path: string;
    type: "directory" | "file" | "symlink" | "other";
    size: number | null;
    modifiedAt: string;
    createdAt: string;
  }>;
};

const {
  setPinsSpy,
  mkdirSpy,
  renameSpy,
  copySpy,
  moveSpy,
  deleteSpy,
  writeTextSpy,
  addToastSpy,
  authFetchSpy,
  scrollIntoViewSpy,
  state,
} = vi.hoisted(() => ({
    setPinsSpy: vi.fn(async () => ({})),
    mkdirSpy: vi.fn(async () => ({})),
    renameSpy: vi.fn(async () => ({})),
    copySpy: vi.fn(async () => ({})),
    moveSpy: vi.fn(async () => ({})),
    deleteSpy: vi.fn(async () => ({})),
    writeTextSpy: vi.fn(async () => ({})),
    addToastSpy: vi.fn(),
    authFetchSpy: vi.fn(),
    scrollIntoViewSpy: vi.fn(),
    state: {
      listResults: {
        "": {
          cwd: "C:\\",
          parent: null,
          entries: [
            {
              name: "note.txt",
              path: "C:\\note.txt",
              type: "file" as const,
              size: 64,
              modifiedAt: "2026-01-01T00:00:00.000Z",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              name: "reports",
              path: "C:\\reports",
              type: "directory" as const,
              size: null,
              modifiedAt: "2026-01-02T00:00:00.000Z",
              createdAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        },
        "C:\\reports": {
          cwd: "C:\\reports",
          parent: "C:\\",
          entries: [
            {
              name: "summary.txt",
              path: "C:\\reports\\summary.txt",
              type: "file" as const,
              size: 128,
              modifiedAt: "2026-01-03T00:00:00.000Z",
              createdAt: "2026-01-03T00:00:00.000Z",
            },
          ],
        },
      } as Record<string, MockDirectoryListing>,
      meta: { mimeType: "text/plain", size: 2048 },
      text: { content: "hello", truncated: true, readOnlySuggested: true },
    },
  }));

vi.mock("../../hooks/useAuthGate", () => ({
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

vi.mock("../../hooks/useAppStatus", () => ({
  useAppStatus: vi.fn(),
}));

vi.mock("../../components/layout/TopBar", () => ({
  TopBar: () => <div>TOP_BAR</div>,
}));

vi.mock("../../components/layout/ToastContainer", () => ({
  ToastContainer: () => <div>TOASTS</div>,
}));

vi.mock("../../trpc", () => ({
  TRPCProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTRPC: () => ({
    files: {
      list: {
        queryOptions: (input?: { directoriesOnly?: boolean; path?: string; showHidden?: boolean }) => ({
          queryKey: ["files.list", input?.path ?? "", Boolean(input?.directoriesOnly)],
        }),
      },
      getPins: { queryOptions: () => ({ queryKey: ["files.getPins"] }) },
      getMeta: { queryOptions: (input?: { path?: string }) => ({ queryKey: ["files.getMeta", input?.path ?? ""] }) },
      readText: {
        queryOptions: (input?: { path?: string; forceEditable?: boolean }) => ({
          queryKey: ["files.readText", input?.path ?? "", Boolean(input?.forceEditable)],
        }),
      },
    },
  }),
  trpcClient: {
    files: {
      setPins: { mutate: setPinsSpy },
      mkdir: { mutate: mkdirSpy },
      rename: { mutate: renameSpy },
      copy: { mutate: copySpy },
      move: { mutate: moveSpy },
      delete: { mutate: deleteSpy },
      writeText: { mutate: writeTextSpy },
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn(async () => {}),
    }),
    useMutation: (opts: { mutationFn: (...args: unknown[]) => Promise<unknown> }) => ({
      isPending: false,
      mutateAsync: (...args: unknown[]) => opts.mutationFn(...args),
      mutate: (...args: unknown[]) => {
        void opts.mutationFn(...args);
      },
    }),
    useQuery: (arg: unknown) => {
      const maybe = arg as { queryKey?: unknown[] };
      const key = maybe.queryKey?.[0];
      if (key === "files.list") {
        const requestedPath = String(maybe.queryKey?.[1] ?? "");
        return {
          data: state.listResults[requestedPath] ?? state.listResults[""],
          isFetching: false,
          isLoading: false,
          dataUpdatedAt: Date.now(),
        };
      }
      if (key === "files.getPins") {
        return { data: { items: [] } };
      }
      if (key === "files.getMeta") {
        return { data: state.meta, isLoading: false };
      }
      if (key === "files.readText") {
        return { data: state.text, isLoading: false };
      }
      return { data: null, isFetching: false, isLoading: false, dataUpdatedAt: Date.now() };
    },
  };
});

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../lib/auth", () => ({
  authFetch: authFetchSpy,
}));

describe("files route", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    window.scrollTo = vi.fn();
    setPinsSpy.mockReset();
    mkdirSpy.mockReset();
    renameSpy.mockReset();
    copySpy.mockReset();
    moveSpy.mockReset();
    deleteSpy.mockReset();
    writeTextSpy.mockReset();
    addToastSpy.mockReset();
    authFetchSpy.mockReset();
    scrollIntoViewSpy.mockReset();
    authFetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) });
    state.listResults = {
      "": {
        cwd: "C:\\",
        parent: null,
        entries: [
          {
            name: "note.txt",
            path: "C:\\note.txt",
            type: "file",
            size: 64,
            modifiedAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            name: "reports",
            path: "C:\\reports",
            type: "directory",
            size: null,
            modifiedAt: "2026-01-02T00:00:00.000Z",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
      "C:\\reports": {
        cwd: "C:\\reports",
        parent: "C:\\",
        entries: [
          {
            name: "summary.txt",
            path: "C:\\reports\\summary.txt",
            type: "file",
            size: 128,
            modifiedAt: "2026-01-03T00:00:00.000Z",
            createdAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
    };
    state.meta = { mimeType: "text/plain", size: 2048 };
    state.text = { content: "hello", truncated: true, readOnlySuggested: true };
  });

  it("renders files page shell", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithAppRouter({ initialEntries: ["/files"] });
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(
      consoleErrorSpy.mock.calls.some(([message]) =>
        String(message).includes("<button> cannot contain a nested <button>")
      )
    ).toBe(false);
    consoleErrorSpy.mockRestore();
  });

  it("enforces large-text read-only mode until explicit enable editing", async () => {
    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.doubleClick(await screen.findByText("note.txt"));
    expect(await screen.findByText("Enable Editing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByText("Enable Editing"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("preserves row interaction semantics for selection and open", async () => {
    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.click(await screen.findByText("note.txt"));
    expect(screen.getByText("Selected: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("note.txt"));
    expect(await screen.findByText("Back")).toBeInTheDocument();
  });

  it("handles upload and confirmation-gated delete flows", async () => {
    const { container } = renderWithAppRouter({ initialEntries: ["/files"] });
    await screen.findByText("Files");
    const dropTarget = container.querySelector(".files-main") as HTMLElement;
    const file = new File(["abc"], "hello.txt", { type: "text/plain" });
    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [file] },
    });
    await waitFor(() => expect(authFetchSpy).toHaveBeenCalled());

    fireEvent.click(screen.getByText("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ path: "C:\\note.txt" }));
  });

  it("validates copy cut paste behaviors including same-path protection", async () => {
    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.click(await screen.findByText("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(copySpy).not.toHaveBeenCalled());
    expect(addToastSpy).toHaveBeenCalledWith("Pasted 0 item(s)", "success");

    fireEvent.click(screen.getByText("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(moveSpy).not.toHaveBeenCalled());
  });

  it("initializes the directory from a folder deep link", async () => {
    renderWithAppRouter({ initialEntries: ["/files?path=C%3A%5Creports&source=disk-analysis"] });

    await waitFor(() => expect(screen.getByDisplayValue("C:\\reports")).toBeInTheDocument());
    expect(screen.getByText("summary.txt")).toBeInTheDocument();
  });

  it("reveals and scrolls the target file from a deep link", async () => {
    renderWithAppRouter({
      initialEntries: ["/files?reveal=C%3A%5Creports%5Csummary.txt&source=disk-analysis"],
    });

    await waitFor(() => expect(screen.getByDisplayValue("C:\\reports")).toBeInTheDocument());
    expect(await screen.findByText("summary.txt")).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoViewSpy).toHaveBeenCalled());
  });

  it("clears pending reveal state when the target file is missing", async () => {
    renderWithAppRouter({
      initialEntries: ["/files?reveal=C%3A%5Creports%5Cmissing.txt&source=disk-analysis"],
    });

    await waitFor(() => expect(screen.getByDisplayValue("C:\\reports")).toBeInTheDocument());
    expect(screen.getByText("summary.txt")).toBeInTheDocument();
    expect(screen.getByText("Selected: none")).toBeInTheDocument();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });
});
