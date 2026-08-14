import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithAppRouter } from "../../test/helpers/router";

type MockDirectoryListing = {
  cwd: string;
  parent: string | null;
  truncated?: boolean;
  entries: Array<{
    name: string;
    path: string;
    type: "directory" | "file" | "symlink" | "other";
    size: number | null;
    modifiedAt: string;
    createdAt: string;
    isSymlink?: boolean;
    linkTarget?: string | null;
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
  invalidateQueriesSpy,
  state,
  forcedTextCache,
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
    // Hoisted (not a fresh vi.fn() per useQueryClient() call) so call counts
    // accumulate across renders -- it's how tests observe that
    // refreshDirectory actually ran, since the mocked useQuery below serves
    // static `state.listResults` regardless of invalidation.
    invalidateQueriesSpy: vi.fn(async () => {}),
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
    // Keyed by `state.text` so the `useQuery` mock hands back a stable object
    // identity across re-renders while forceEditable is true. Without this,
    // every render would build a fresh `{...state.text, readOnlySuggested:
    // false}`, and the effect that seeds the editor from `readTextQuery.data`
    // (keyed on that object identity) would fire on every render, wiping out
    // any edit the test just made and making the truncation gate impossible
    // to exercise from a test.
    forcedTextCache: new WeakMap<
      { content: string; truncated: boolean; readOnlySuggested: boolean },
      { content: string; truncated: boolean; readOnlySuggested: false }
    >(),
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

vi.mock("../../components/ui/CodeEditor", () => ({
  CodeEditor: (props: {
    value: string;
    onChange: (value: string) => void;
    readonly?: boolean;
  }) => (
    <textarea
      aria-label="file editor"
      value={props.value}
      readOnly={props.readonly}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: invalidateQueriesSpy,
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
        // Mirror the server: forceEditable clears readOnlySuggested but never
        // clears truncated (H1) -- a 10 MB file stays truncated regardless of
        // who is allowed to edit the 2 MB prefix that got read back.
        const forceEditable = Boolean(maybe.queryKey?.[2]);
        if (forceEditable && state.text.readOnlySuggested) {
          let forced = forcedTextCache.get(state.text);
          if (!forced) {
            forced = { ...state.text, readOnlySuggested: false };
            forcedTextCache.set(state.text, forced);
          }
          return { data: forced, isLoading: false };
        }
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
    invalidateQueriesSpy.mockReset();
    invalidateQueriesSpy.mockResolvedValue(undefined);
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

  it("keeps Save disabled while the content is truncated, even after Enable Editing and an edit", async () => {
    // Open a 10 MB file: the server caps content at 2 MB and sets truncated.
    // Enable Editing clears readOnlySuggested but NOT truncated -- a save
    // would fs.writeFile the 2 MB prefix over the whole file, losing 8 MB
    // with no undo (CLI-1 / CLI-11).
    state.meta = { mimeType: "text/plain", size: 10 * 1024 * 1024 };
    state.text = { content: "x".repeat(2048), truncated: true, readOnlySuggested: true };

    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.doubleClick(await screen.findByText("note.txt"));

    fireEvent.click(await screen.findByText("Enable Editing"));

    // Without a real edit, Save stays disabled for an unrelated reason
    // (nothing is dirty), which would let a stale truncated-gate bug hide
    // behind that unrelated disablement. Make an edit so Save's disabled
    // state is actually driven by the truncation gate.
    fireEvent.change(screen.getByLabelText("file editor"), {
      target: { value: "y".repeat(2048) },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers Open as text for a file with no preview, and switches the viewer", async () => {
    // The extension map has never heard of this, so the server calls it
    // octet-stream and the viewer lands on the no-preview card.
    state.meta = { mimeType: "application/octet-stream", size: 512 };
    state.text = { content: "root=/dev/sda1", truncated: false, readOnlySuggested: false };

    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.doubleClick(await screen.findByText("note.txt"));

    expect(await screen.findByText("Preview not available")).toBeInTheDocument();
    const openAsText = screen.getByRole("button", { name: /Open as text/i });

    fireEvent.click(openAsText);

    // The card is replaced by the editor, and Save is live: a file opened this
    // way that could not be saved would be worse than not opening it.
    await waitFor(() => {
      expect(screen.queryByText("Preview not available")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("preserves row interaction semantics for selection and open", async () => {
    renderWithAppRouter({ initialEntries: ["/files"] });
    fireEvent.click(await screen.findByText("note.txt"));
    expect(screen.getByText("Selected: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("note.txt"));
    expect(await screen.findByText("Back")).toBeInTheDocument();
  });

  it("badges a symlinked entry and names its target in the row title", async () => {
    // isSymlink/linkTarget come back on every entry (FILE-3) and were
    // previously ignored entirely -- a symlinked file looked identical to an
    // ordinary one.
    state.listResults[""] = {
      cwd: "C:\\",
      parent: null,
      entries: [
        {
          name: "linked.txt",
          path: "C:\\linked.txt",
          type: "file",
          size: 64,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          isSymlink: true,
          linkTarget: "C:\\real\\target.txt",
        },
      ],
    };

    renderWithAppRouter({ initialEntries: ["/files"] });
    await screen.findByText("linked.txt");

    expect(screen.getByText("LINK")).toBeInTheDocument();
    const row = screen.getByText("linked.txt").closest("tr");
    expect(row).toHaveAttribute("title", expect.stringContaining("C:\\real\\target.txt"));
  });

  it("warns when a directory listing is truncated", async () => {
    // `truncated` comes back on files.list and was previously ignored, so a
    // directory past MAX_LIST_ENTRIES silently looked complete.
    state.listResults[""] = {
      cwd: "C:\\",
      parent: null,
      truncated: true,
      entries: [
        {
          name: "note.txt",
          path: "C:\\note.txt",
          type: "file",
          size: 64,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    renderWithAppRouter({ initialEntries: ["/files"] });
    expect(await screen.findByText(/more items than can be shown/i)).toBeInTheDocument();
  });

  it("does not warn when a directory listing is not truncated", async () => {
    renderWithAppRouter({ initialEntries: ["/files"] });
    await screen.findByText("note.txt");
    expect(screen.queryByText(/more items than can be shown/i)).not.toBeInTheDocument();
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

  it("continues past a failed delete, names the failed item, and still refreshes", async () => {
    // Select five, the third is permission-denied: files 1-2 and 4-5 must
    // still be attempted (no early exit from the loop), and the listing must
    // still refresh even though one item failed -- otherwise the table keeps
    // listing an entry that's already gone from disk.
    state.listResults[""] = {
      cwd: "C:\\",
      parent: null,
      entries: [1, 2, 3, 4, 5].map((n) => ({
        name: `file${n}.txt`,
        path: `C:\\file${n}.txt`,
        type: "file" as const,
        size: 10,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    };
    deleteSpy
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    renderWithAppRouter({ initialEntries: ["/files"] });

    fireEvent.click(await screen.findByText("file1.txt"));
    fireEvent.click(screen.getByText("file5.txt"), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(5));
    expect(deleteSpy).toHaveBeenNthCalledWith(3, { path: "C:\\file3.txt" });
    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith(
        "Deleted 4 of 5 item(s); 1 failed: file3.txt",
        "error"
      )
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(1);
  });

  it("continues past a rejected upload response and names the file that didn't land", async () => {
    // A partial upload failure still returns 400, but the payload's `uploaded`
    // array names exactly which files did land -- diff that against what was
    // sent to report which one didn't, and refresh regardless of the status.
    authFetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Total upload size exceeded", uploaded: ["a.txt"] }),
    });

    const { container } = renderWithAppRouter({ initialEntries: ["/files"] });
    await screen.findByText("Files");
    const dropTarget = container.querySelector(".files-main") as HTMLElement;
    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    fireEvent.drop(dropTarget, { dataTransfer: { files: [fileA, fileB] } });

    await waitFor(() => expect(authFetchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith(
        "Uploaded 1 of 2 item(s); 1 failed: b.txt",
        "error"
      )
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(1);
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

  it("continues past a failed move mid-paste, names the failed item, and still refreshes", async () => {
    // Cut three files from root, paste into a different folder; the second
    // move fails. A partially-completed cut must not leave the source files
    // gone but still listed -- the loop must finish and the listing refresh.
    state.listResults[""] = {
      cwd: "C:\\",
      parent: null,
      entries: [
        {
          name: "dest",
          path: "C:\\dest",
          type: "directory" as const,
          size: null,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        ...[1, 2, 3].map((n) => ({
          name: `file${n}.txt`,
          path: `C:\\file${n}.txt`,
          type: "file" as const,
          size: 10,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      ],
    };
    state.listResults["C:\\dest"] = { cwd: "C:\\dest", parent: "C:\\", entries: [] };
    moveSpy
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("EBUSY"))
      .mockResolvedValueOnce({});

    const { container } = renderWithAppRouter({ initialEntries: ["/files"] });
    await screen.findByText("file1.txt");
    // "dest" is a directory, so it also renders in the sidebar's directory
    // tree; scope to the main listing panel to find the row for it.
    const mainPanel = container.querySelector(".files-main") as HTMLElement;

    fireEvent.click(screen.getByText("file1.txt"));
    fireEvent.click(screen.getByText("file3.txt"), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.doubleClick(within(mainPanel).getByText("dest"));
    await waitFor(() => expect(screen.getByDisplayValue("C:\\dest")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => expect(moveSpy).toHaveBeenCalledTimes(3));
    expect(moveSpy).toHaveBeenNthCalledWith(2, {
      sourcePath: "C:\\file2.txt",
      targetPath: "C:\\dest\\file2.txt",
    });
    await waitFor(() =>
      expect(addToastSpy).toHaveBeenCalledWith(
        "Pasted 2 of 3 item(s); 1 failed: file2.txt",
        "error"
      )
    );
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(1);
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
