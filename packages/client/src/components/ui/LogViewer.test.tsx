import { act, render, screen } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogViewer } from "./LogViewer";
import { useConnectionStore } from "../../stores/connection";

const authFetchMock = vi.fn();

vi.mock("../../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../../lib/auth")>("../../lib/auth");
  return {
    ...actual,
    authFetch: (...args: unknown[]) => authFetchMock(...args),
  };
});

const containers = [{ id: "c1", name: "CONTAINER_ONE" }];

/** An SSE body that delivers `lines` and then ends, like an exited container. */
function sseResponse(lines: string[], status = 200): Response {
  const body = lines.map((line) => `data: ${JSON.stringify({ line })}\n\n`).join("");
  return new Response(status === 200 ? body : null, { status });
}

function resetConnectionStore() {
  useConnectionStore.setState({
    connections: {
      api: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      metrics: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      events: { connected: false, lastConnectedAt: null, attemptCount: 0 },
      logs: { connected: false, lastConnectedAt: null, attemptCount: 0 },
    },
  });
}

/** Lets the fetch promise and the stream reads settle under fake timers. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LogViewer", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    resetConnectionStore();
    vi.useRealTimers();
  });

  // CLI-6
  it("stops retrying after a 4xx that is not 401", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse([], 404));

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });
    await settle();

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/not retrying/)).toBeInTheDocument();
  });

  it("offers a manual retry out of the permanent-failure latch", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse([], 404));

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    authFetchMock.mockResolvedValue(sseResponse(["back"], 200));
    await act(async () => {
      screen.getByRole("button", { name: "RETRY" }).click();
    });
    await settle();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/not retrying/)).not.toBeInTheDocument();
  });

  it("keeps retrying a 401 so an unlock can resume the stream", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse([], 401));

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  // CLI-6, the case the backoff exists for: an exited container answers 200 and
  // then ends immediately. Resetting the attempt counter on `res.ok` pinned this
  // to the 3s base forever, and the 500-based test below never reached that line.
  it("backs off when a 200 stream ends immediately (exited container)", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse([], 200));

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    // The second retry must wait ~6s, not another 3s.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(3);

    // ...and the third ~12s.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(4);
  });

  it("forgives the backoff only after a stream has stayed open", async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    authFetchMock.mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ line: "alive" })}\n\n`)
          );
          release = () => controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Stay connected past STREAM_USEFUL_MS, then drop.
    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    await act(async () => {
      release?.();
    });
    await settle();

    // The counter is forgiven, so the next attempt is back at the 3s base.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially when the stream keeps failing", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse([], 500));

    render(<LogViewer containers={containers} />);
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    // The second retry waits 6s, not another 3s.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await settle();
    expect(authFetchMock).toHaveBeenCalledTimes(3);
  });

  // CLI-14
  it("keys rows by a monotonic sequence rather than array index", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse(["alpha", "bravo"]));

    render(<LogViewer containers={containers} />);
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    const rows = Array.from(document.querySelectorAll("[data-log-seq]"));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("bravo"),
    ]);
    const seqs = rows.map((row) => Number(row.getAttribute("data-log-seq")));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // CLI-14: the store was subscribed without a selector, so every health-poll /
  // metrics / docker-events `setConnected` re-rendered the whole log list.
  it("does not re-render when an unrelated connection changes", async () => {
    vi.useFakeTimers();
    authFetchMock.mockResolvedValue(sseResponse(["alpha"]));

    let commits = 0;
    const onRender = () => {
      commits++;
    };
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <Profiler id="log-viewer" onRender={onRender}>
          {children}
        </Profiler>
      );
    }

    render(
      <Wrapper>
        <LogViewer containers={containers} />
      </Wrapper>
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    const commitsBefore = commits;
    act(() => {
      useConnectionStore.getState().setConnected("metrics", true);
      useConnectionStore.getState().setConnected("events", true);
      useConnectionStore.getState().setConnected("api", true);
    });

    expect(commits).toBe(commitsBefore);
  });
});
