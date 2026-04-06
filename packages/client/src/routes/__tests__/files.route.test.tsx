import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "../files";

const { setPinsSpy, mkdirSpy, renameSpy, copySpy, moveSpy, deleteSpy, writeTextSpy, addToastSpy, authFetchSpy, state } =
  vi.hoisted(() => ({
    setPinsSpy: vi.fn(async () => ({})),
    mkdirSpy: vi.fn(async () => ({})),
    renameSpy: vi.fn(async () => ({})),
    copySpy: vi.fn(async () => ({})),
    moveSpy: vi.fn(async () => ({})),
    deleteSpy: vi.fn(async () => ({})),
    writeTextSpy: vi.fn(async () => ({})),
    addToastSpy: vi.fn(),
    authFetchSpy: vi.fn(),
    state: {
      entries: [
        {
          name: "note.txt",
          path: "C:\\note.txt",
          type: "file" as const,
          size: 64,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      meta: { mimeType: "text/plain", size: 2048 },
      text: { content: "hello", truncated: true, readOnlySuggested: true },
    },
  }));

vi.mock("../../trpc", () => ({
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

vi.mock("@tanstack/react-query", () => ({
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
      return {
        data: { cwd: "C:\\", parent: null, entries: state.entries },
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
}));

vi.mock("../../stores/toast", () => ({
  useToastStore: () => ({ addToast: addToastSpy }),
}));

vi.mock("../../lib/auth", () => ({
  authFetch: authFetchSpy,
}));

describe("files route", () => {
  beforeEach(() => {
    setPinsSpy.mockReset();
    mkdirSpy.mockReset();
    renameSpy.mockReset();
    copySpy.mockReset();
    moveSpy.mockReset();
    deleteSpy.mockReset();
    writeTextSpy.mockReset();
    addToastSpy.mockReset();
    authFetchSpy.mockReset();
    authFetchSpy.mockResolvedValue({ ok: true, json: async () => ({}) });
    state.entries = [
      {
        name: "note.txt",
        path: "C:\\note.txt",
        type: "file",
        size: 64,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    state.meta = { mimeType: "text/plain", size: 2048 };
    state.text = { content: "hello", truncated: true, readOnlySuggested: true };
  });

  it("renders files page shell", () => {
    const Component = Route.options.component!;
    render(<Component />);
    expect(screen.getByText("Files")).toBeInTheDocument();
  });

  it("enforces large-text read-only mode until explicit enable editing", async () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.doubleClick(screen.getByText("note.txt"));
    expect(await screen.findByText("Enable Editing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByText("Enable Editing"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("preserves row interaction semantics for selection and open", async () => {
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByText("note.txt"));
    expect(screen.getByText("Selected: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("note.txt"));
    expect(await screen.findByText("Back")).toBeInTheDocument();
  });

  it("handles upload and confirmation-gated delete flows", async () => {
    const Component = Route.options.component!;
    const { container } = render(<Component />);
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
    const Component = Route.options.component!;
    render(<Component />);
    fireEvent.click(screen.getByText("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(copySpy).not.toHaveBeenCalled());
    expect(addToastSpy).toHaveBeenCalledWith("Pasted 0 item(s)", "success");

    fireEvent.click(screen.getByText("note.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(moveSpy).not.toHaveBeenCalled());
  });
});
