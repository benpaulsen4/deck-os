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

  // CLI-6: a stream that just ends (exited container) used to re-attach
  // `docker logs` every 3s forever.
  it("backs off exponentially when the stream keeps ending", async () => {
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
