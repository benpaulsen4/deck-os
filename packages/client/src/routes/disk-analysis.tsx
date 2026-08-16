import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, PanelLeft, Play, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { useToastStore } from "../stores/toast";
import { emitUnauthorizedEvent, fetchAuthStatus } from "../lib/auth";
import {
  DiskAnalysisRouteSearchSchema,
  DiskAnalysisScanEventSchema,
  type DiskAnalysisJobState,
  type DiskAnalysisMountIdentity,
  type DiskAnalysisSnapshot,
  type DiskAnalysisTreemapNode,
} from "@deckos/contracts";
import {
  createPresentationTree,
  createSnapshotPresentationTree,
  createSyntheticLiveRoot,
  deriveLegendFromSnapshot,
  describeCancelScanError,
  describeScanStartError,
  getEventMountIdentity,
  formatBytes,
  formatCount,
  formatRelativeGeneratedAt,
  getMountLabel,
  getMountStatePollIntervalMs,
  getNodeNavigationSearch,
  integrateBranchIntoTree,
  resolveHoveredNode,
} from "../lib/diskAnalysisClient";
import { useTRPC, trpcClient } from "../trpc";
import { HoverDetails, LegendRow, ScanIssuesModal, SidebarStat } from "./disk-analysis.components";
import { TreemapCanvas } from "./disk-analysis.treemap";

export const Route = createFileRoute("/disk-analysis")({
  validateSearch: (search) => DiskAnalysisRouteSearchSchema.parse(search),
  component: DiskAnalysisPage,
});

type ViewMode = "cached" | "live";
const LIVE_EVENT_BATCH_MS = 0;
const LIVE_MERGE_PUBLISH_MS = 250;
const LIVE_PRESENTATION_OPTIONS = {
  maxDepth: 4,
  maxChildrenPerDirectory: 36,
};
const LIVE_SCANNING_PRESENTATION_OPTIONS = {
  maxDepth: 3,
  maxChildrenPerDirectory: 24,
};

function DiskAnalysisPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { addToast } = useToastStore();
  const mount = useMemo(
    () =>
      search.fs
        ? ({
            mount: search.mount,
            fs: search.fs,
          } satisfies DiskAnalysisMountIdentity)
        : null,
    [search.fs, search.mount]
  );
  const mountKey = mount ? `${mount.mount}::${mount.fs}` : "missing-mount";
  const mountStateQueryKey = useMemo(
    () =>
      mount
        ? (["diskAnalysis.getMountState", mount.mount, mount.fs] as const)
        : (["diskAnalysis.getMountState", "", ""] as const),
    [mount]
  );
  const snapshotQueryKey = useMemo(
    () =>
      mount
        ? (["diskAnalysis.getSnapshot", mount.mount, mount.fs] as const)
        : (["diskAnalysis.getSnapshot", "", ""] as const),
    [mount]
  );

  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [liveRoot, setLiveRoot] = useState<DiskAnalysisTreemapNode | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<DiskAnalysisSnapshot | null>(null);
  const [liveJob, setLiveJob] = useState<DiskAnalysisJobState | null>(null);
  const [streamPath, setStreamPath] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [isIssuesModalOpen, setIsIssuesModalOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(true);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [hasRequestedLive, setHasRequestedLive] = useState(false);
  const requestedStreamKeyRef = useRef<string | null>(null);
  const liveRawRootRef = useRef<DiskAnalysisTreemapNode | null>(null);
  /** The job id a pending `startScan` was meant to join, or null if it was a fresh scan. */
  const expectedJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamPath(null);
    setStreamError(null);
    setStreamNotice(null);
    setHoveredPath(null);
    setIsIssuesModalOpen(false);
    setMobileSidebarOpen(true);
    setHasRequestedLive(false);
    requestedStreamKeyRef.current = null;
    liveRawRootRef.current = null;
    expectedJobIdRef.current = null;
  }, [mountKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setIsCompactLayout(false);
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 1100px)");
    const updateCompactLayout = () => {
      setIsCompactLayout(mediaQuery.matches);
    };
    updateCompactLayout();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateCompactLayout);
      return () => {
        mediaQuery.removeEventListener("change", updateCompactLayout);
      };
    }
    mediaQuery.addListener(updateCompactLayout);
    return () => {
      mediaQuery.removeListener(updateCompactLayout);
    };
  }, []);

  const mountStateQuery = useQuery(
    trpc.diskAnalysis.getMountState.queryOptions(mount ?? { mount: "", fs: "" }, {
      enabled: !!mount,
      // See `getMountStatePollIntervalMs` -- keeps `canWatchRunningScan`
      // truthful while a job is actually running, and stops polling the
      // instant one isn't, so a page left open never grows a timer that
      // outlives the scan it was watching for.
      refetchInterval: (query) => getMountStatePollIntervalMs(query.state.data ?? null),
    })
  );
  const snapshotQuery = useQuery(
    trpc.diskAnalysis.getSnapshot.queryOptions(mount ?? { mount: "", fs: "" }, {
      enabled: !!mount,
    })
  );

  const startScanMutation = useMutation({
    mutationFn: async (input: DiskAnalysisMountIdentity) =>
      await trpcClient.diskAnalysis.startScan.mutate({
        mount: input,
      }),
    onSuccess: (result) => {
      // The job this request meant to join, recorded at click time. `startScan`
      // joins an active job for the mount and starts a new one otherwise, and
      // the client does not get to assume which happened: if the job settled
      // during the round trip the server will have answered with a different,
      // freshly started scan. Streaming that silently, under a button that said
      // "watch the running scan", is the one thing worse than the extra scan.
      const expectedJobId = expectedJobIdRef.current;
      expectedJobIdRef.current = null;
      setStreamPath(result.streamPath);
      setStreamError(null);
      if (expectedJobId && expectedJobId !== result.jobId) {
        // Notice only, no toast: this sits next to the stream status it
        // describes, self-clears when that stream ends (`endStream` below),
        // and can't be missed by someone watching this sidebar for a scan
        // they just started.
        setStreamNotice(
          "The scan you asked to watch had already finished - this is a new scan that just started."
        );
        return;
      }
      setStreamNotice(null);
    },
    onError: (error: unknown) => {
      // A refused path and a busy scanner are different answers -- see
      // `describeScanStartError` and the router's `mapDiskAnalysisError`.
      const message = describeScanStartError(error);
      setStreamError(message);
      addToast(message, "error");
    },
  });

  const cancelScanMutation = useMutation({
    mutationFn: async (input: { mount: DiskAnalysisMountIdentity; jobId: string }) =>
      await trpcClient.diskAnalysis.cancelScan.mutate(input),
    onSuccess: (result: { success: boolean }) => {
      if (!result.success) {
        // Not an error: the job the button captured at click time had
        // already finished (or been superseded) by the time the request
        // landed on the server -- `diskAnalysisService.cancelScan` reports
        // that as `{ success: false }`, the same "the world moved on"
        // outcome `onSuccess` above already treats as informational rather
        // than a failure for a mismatched `startScan` join.
        addToast("That scan had already finished.", "info");
        return;
      }
      // A successful cancel does not end the job synchronously -- the
      // service sets phase `cancelled` and the worker still has to unwind
      // out of `readdir` (the "still winding down" guard below exists for
      // exactly this window). So there is nothing further to do here: the
      // existing SSE stream and `getMountStatePollIntervalMs` polling will
      // observe the terminal phase on their own. Forcing a refetch from
      // here would be a second, redundant path into that same wind-down
      // window.
    },
    onError: (error: unknown) => {
      addToast(describeCancelScanError(error), "error");
    },
  });

  const cachedSnapshot = snapshotQuery.data?.snapshot ?? null;
  const mountState = mountStateQuery.data ?? null;
  const activeJob = liveJob ?? mountState?.activeJob ?? null;
  // The one signal for "a scan is actually running right now", reused by
  // `canWatchRunningScan`, the live-vs-cached presentation budget below, and
  // the Cancel Scan button -- rather than each inventing its own notion of
  // "running" against `activeJob`.
  const isJobActive = activeJob?.phase === "queued" || activeJob?.phase === "scanning";
  const diskAnalysisQueriesSettled =
    !mountStateQuery.isLoading &&
    !mountStateQuery.isFetching &&
    !snapshotQuery.isLoading &&
    !snapshotQuery.isFetching;

  const resetLiveState = () => {
    setLiveRoot(null);
    setLiveSnapshot(null);
    setLiveJob(null);
    setStreamError(null);
    setStreamNotice(null);
    requestedStreamKeyRef.current = null;
    liveRawRootRef.current = null;
  };

  const requestLiveStream = (options?: { resetLiveState?: boolean }) => {
    if (!mount || startScanMutation.isPending) {
      return;
    }
    if (options?.resetLiveState) {
      resetLiveState();
    }
    const requestKey = `${mountKey}::${mountState?.activeJob?.jobId ?? "pending"}`;
    if (requestedStreamKeyRef.current === requestKey) {
      return;
    }
    requestedStreamKeyRef.current = requestKey;
    // Null when there is nothing to join, which is the "start a new scan" case
    // and has no expectation to disappoint. See `onSuccess`.
    expectedJobIdRef.current = mountState?.activeJob?.jobId ?? null;
    startScanMutation.mutate(mount);
  };

  const openLiveView = () => {
    setHasRequestedLive(true);
    setViewMode("live");
    if (!mount) {
      return;
    }
    if (streamPath) {
      return;
    }
    if (!mountState?.activeJob && (liveSnapshot || liveRoot)) {
      return;
    }
    requestLiveStream({
      resetLiveState: mountState?.activeJob ? liveJob?.jobId !== mountState.activeJob.jobId : true,
    });
  };

  const showCachedView = () => {
    setViewMode("cached");
    if (streamPath) {
      requestedStreamKeyRef.current = null;
      setStreamPath(null);
    }
  };

  /**
   * The one path into `startScan`, shared by "Start Scan", "Scan This Mount"
   * and "Watch Running Scan". There is deliberately no effect anywhere in
   * this component that calls it automatically — every scan start is a
   * user-initiated click.
   *
   * The three buttons differ in what they promise the user, not in what they
   * do: the server decides whether this joins the job already running on the
   * mount or starts a new one, and `onSuccess` reports back when that decision
   * was not the one the button implied.
   */
  const startManualScan = () => {
    setHasRequestedLive(true);
    setViewMode("live");
    requestLiveStream({
      resetLiveState: true,
    });
  };

  useEffect(() => {
    if (cachedSnapshot) {
      setViewMode((current) => {
        if (current === "cached" || (current === "live" && hasRequestedLive)) {
          return current;
        }
        return "cached";
      });
      return;
    }
    setViewMode("live");
  }, [cachedSnapshot, hasRequestedLive]);

  useEffect(() => {
    if (viewMode === "live" || !streamPath) {
      return;
    }
    requestedStreamKeyRef.current = null;
    setStreamPath(null);
  }, [streamPath, viewMode]);

  useEffect(() => {
    if (!activeJob || liveSnapshot || !cachedSnapshot) {
      return;
    }
    if (activeJob.phase !== "completed" && activeJob.phase !== "partial") {
      return;
    }
    if (mountState?.cache.state !== "fresh") {
      return;
    }
    if (mountState.cache.generatedAt !== cachedSnapshot.generatedAt) {
      return;
    }

    liveRawRootRef.current = cachedSnapshot.root;
    setLiveSnapshot(cachedSnapshot);
    setLiveRoot(createSnapshotPresentationTree(cachedSnapshot.root, LIVE_PRESENTATION_OPTIONS));
  }, [activeJob, cachedSnapshot, liveSnapshot, mountState]);
  const livePresentationOptions = isJobActive
    ? LIVE_SCANNING_PRESENTATION_OPTIONS
    : LIVE_PRESENTATION_OPTIONS;

  useEffect(() => {
    if (!streamPath || !mount) {
      return;
    }

    let disposed = false;
    let flushTimer: number | null = null;
    let mergeTimer: number | null = null;
    const pendingBranches = new Map<string, DiskAnalysisTreemapNode>();
    const queuedBranches: DiskAnalysisTreemapNode[] = [];
    let pendingJob: DiskAnalysisJobState | null = null;
    // Progress events carry an empty `issues` array by design (see
    // packages/server/src/services/diskAnalysis.ts -- only `issueCount`
    // travels on the ~500ms progress cadence; the populated, capped array
    // belongs to status/snapshot events). Overwriting the last known
    // (populated) array with `[]` on every tick blanked the live issues
    // panel for the whole scan and, combined with the modal-close effect
    // below, force-closed an open Scan Issues modal out from under the user
    // reading it. This tracks the last array a status/snapshot event
    // actually populated, so progress events can keep showing it.
    //
    // Seeded from `mountState?.activeJob?.issues` as well as `liveJob?.issues`:
    // attaching to a job that was already scanning before this connection
    // opened has no prior "status" event to seed from -- the only source of
    // truth for what's showing right now is the mount-state snapshot the
    // page loaded with.
    let lastKnownIssues: DiskAnalysisJobState["issues"] =
      liveJob?.issues ?? mountState?.activeJob?.issues ?? [];
    // The mount identity the *server* is using, which is the only one the
    // streamed paths agree with.
    //
    // Every path in the tree descends from `path.resolve(mount)`, while
    // `mount` here is parsed straight out of the `?mount=` search param. When
    // those two strings differ, no branch ever equals the root, so
    // `buildAncestorChain` walks past it to `/` and hangs the whole live tree
    // under a phantom node one level too deep. A trailing separator is the
    // easiest way to see it, but `.`/`..` segments, doubled separators and
    // Windows drive-letter case do it too -- and none of them can be undone
    // client-side, because `path.resolve` needs a cwd and a platform the
    // browser does not have. So rather than guess, take the identity the
    // server puts on its own events: `job.mount`/`branch.mount` are
    // `ensureJob`'s resolved mount. Seeded from the mount-state query for the
    // window before the first event lands.
    let liveMount: DiskAnalysisMountIdentity = mountState?.activeJob?.mount ?? mount;
    let mergeRoot = liveRawRootRef.current;
    let lastPublishedAtMs = 0;
    const source = new EventSource(streamPath);

    const publishPresentation = (root: DiskAnalysisTreemapNode | null) => {
      const nextPresentation = createPresentationTree(root, livePresentationOptions);
      startTransition(() => {
        setLiveRoot(nextPresentation);
      });
    };

    const scheduleMerge = () => {
      if (disposed || mergeTimer !== null) {
        return;
      }
      mergeTimer = window.setTimeout(() => {
        mergeTimer = null;
        if (disposed) {
          return;
        }
        if (queuedBranches.length === 0) {
          if (mergeRoot !== liveRawRootRef.current) {
            liveRawRootRef.current = mergeRoot;
            publishPresentation(mergeRoot);
          }
          return;
        }

        const mergeStartedAt = performance.now();
        let nextRoot = mergeRoot ?? createSyntheticLiveRoot(liveMount);
        while (queuedBranches.length > 0) {
          const branch = queuedBranches.shift();
          if (!branch) {
            continue;
          }
          nextRoot = integrateBranchIntoTree(nextRoot, liveMount, branch);
          if (performance.now() - mergeStartedAt >= 12) {
            break;
          }
        }
        mergeRoot = nextRoot;
        liveRawRootRef.current = nextRoot;
        if (queuedBranches.length > 0) {
          if (performance.now() - lastPublishedAtMs >= LIVE_MERGE_PUBLISH_MS) {
            lastPublishedAtMs = performance.now();
            publishPresentation(nextRoot);
          }
          scheduleMerge();
          return;
        }
        lastPublishedAtMs = performance.now();
        publishPresentation(nextRoot);
      }, 0);
    };

    const flushPending = () => {
      if (disposed) {
        return;
      }
      flushTimer = null;
      const nextJob = pendingJob;
      pendingJob = null;
      const branches = [...pendingBranches.values()];
      pendingBranches.clear();

      if (nextJob) {
        setLiveJob(nextJob);
      }
      if (branches.length === 0) {
        return;
      }
      queuedBranches.push(...branches);
      scheduleMerge();
    };

    const scheduleFlush = (immediate: boolean = false) => {
      if (disposed) {
        return;
      }
      if (immediate) {
        if (flushTimer !== null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushPending();
        return;
      }
      if (flushTimer !== null) {
        return;
      }
      flushTimer = window.setTimeout(flushPending, LIVE_EVENT_BATCH_MS);
    };

    // Whatever ends this stream -- a terminal status/progress event or a
    // snapshot event, the two places that call `setStreamPath(null)` below --
    // must also retire the mismatch notice describing it. Without this it
    // outlived the scan it was reporting on (B7 review round 2, finding 4;
    // round 3 found the fix only covered one of the two endings).
    const endStream = () => {
      setStreamPath(null);
      setStreamNotice(null);
    };

    const handleEvent = (event: Event) => {
      if (disposed) {
        return;
      }
      try {
        const messageEvent = event as MessageEvent<string>;
        const parsed = DiskAnalysisScanEventSchema.parse(JSON.parse(messageEvent.data));
        // One assignment, at the entry point, for every event shape that names
        // a mount -- the per-shape discrimination lives in (and is tested as)
        // `getEventMountIdentity`. A keepalive names none, so the last known
        // identity stands.
        liveMount = getEventMountIdentity(parsed) ?? liveMount;
        if (parsed.event === "status" || parsed.event === "progress") {
          if (parsed.event === "status") {
            lastKnownIssues = parsed.job.issues;
            pendingJob = parsed.job;
          } else {
            pendingJob = { ...parsed.job, issues: lastKnownIssues };
          }
          if (
            parsed.job.phase === "completed" ||
            parsed.job.phase === "partial" ||
            parsed.job.phase === "failed" ||
            parsed.job.phase === "cancelled"
          ) {
            scheduleFlush(true);
            requestedStreamKeyRef.current = null;
            if (parsed.job.phase === "completed" || parsed.job.phase === "partial") {
              void queryClient.invalidateQueries({
                queryKey: mountStateQueryKey,
              });
              void queryClient.invalidateQueries({
                queryKey: snapshotQueryKey,
              });
            }
            endStream();
            return;
          }
          scheduleFlush();
          return;
        }
        if (parsed.event === "branch") {
          pendingBranches.set(parsed.branch.path, parsed.branch);
          scheduleFlush();
          return;
        }
        if (parsed.event === "snapshot") {
          scheduleFlush(true);
          if (mergeTimer !== null) {
            window.clearTimeout(mergeTimer);
            mergeTimer = null;
          }
          queuedBranches.length = 0;
          lastKnownIssues = parsed.job.issues;
          setLiveJob(parsed.job);
          setLiveSnapshot(parsed.snapshot);
          mergeRoot = parsed.snapshot.root;
          liveRawRootRef.current = parsed.snapshot.root;
          lastPublishedAtMs = performance.now();
          publishPresentation(parsed.snapshot.root);
          requestedStreamKeyRef.current = null;
          endStream();
          void queryClient.invalidateQueries({
            queryKey: mountStateQueryKey,
          });
          void queryClient.invalidateQueries({
            queryKey: snapshotQueryKey,
          });
        }
      } catch (error) {
        console.error("Failed to handle disk analysis SSE event:", error);
      }
    };

    source.onopen = () => {
      setStreamError(null);
    };
    source.onerror = () => {
      if (disposed) {
        return;
      }
      setStreamError("Live scan stream disconnected.");
      void fetchAuthStatus()
        .then((status) => {
          if (status.enabled && !status.unlocked) {
            emitUnauthorizedEvent();
          }
        })
        .catch(() => undefined);
    };

    source.addEventListener("status", handleEvent);
    source.addEventListener("progress", handleEvent);
    source.addEventListener("branch", handleEvent);
    source.addEventListener("snapshot", handleEvent);

    return () => {
      disposed = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
      if (mergeTimer !== null) {
        window.clearTimeout(mergeTimer);
      }
      source.removeEventListener("status", handleEvent);
      source.removeEventListener("progress", handleEvent);
      source.removeEventListener("branch", handleEvent);
      source.removeEventListener("snapshot", handleEvent);
      source.close();
    };
  }, [livePresentationOptions, mount, mountStateQueryKey, queryClient, snapshotQueryKey, streamPath]);

  const liveAvailable =
    !!mountState?.activeJob || !!streamPath || !!liveJob || !!liveRoot || !!liveSnapshot;
  const activeView =
    viewMode === "cached" && cachedSnapshot
      ? "cached"
      : liveAvailable
        ? "live"
        : cachedSnapshot
          ? "cached"
          : ("live" satisfies ViewMode);
  // DISK-15: pruning used to reach only the in-progress tree, so a cached or
  // just-completed snapshot went to the treemap whole. Both memos are keyed on
  // the root object, which is also what the hover index caches against -- for
  // a tree under the node budget `createSnapshotPresentationTree` returns that
  // very object, so nothing downstream sees a new identity and nothing is
  // re-indexed.
  const cachedRootForView = useMemo(
    () => createSnapshotPresentationTree(cachedSnapshot?.root ?? null, LIVE_PRESENTATION_OPTIONS),
    [cachedSnapshot?.root]
  );
  const liveSnapshotRootForView = useMemo(
    () => createSnapshotPresentationTree(liveSnapshot?.root ?? null, LIVE_PRESENTATION_OPTIONS),
    [liveSnapshot?.root]
  );
  const liveRootForView =
    activeJob?.phase === "queued" || activeJob?.phase === "scanning"
      ? liveRoot
      : liveSnapshotRootForView ?? liveRoot;
  const currentRoot = activeView === "cached" ? cachedRootForView : liveRootForView;
  const currentSnapshot = activeView === "cached" ? cachedSnapshot : liveSnapshot;
  const legend =
    activeView === "cached"
      ? deriveLegendFromSnapshot(cachedSnapshot)
      : currentSnapshot
        ? deriveLegendFromSnapshot(currentSnapshot)
        : deriveLegendFromSnapshot(cachedSnapshot);
  const legendByExtension = useMemo(
    () => new Map(legend.map((item) => [item.extension, item])),
    [legend]
  );
  const hoveredNode = useMemo(
    () =>
      resolveHoveredNode(
        currentRoot,
        // The unpruned tree behind the view, so a hover that lands on
        // something pruning dropped can still be resolved. Each of these is
        // indexed lazily and only on a miss, which in practice means never:
        // the treemap only ever emits paths it drew, and it draws
        // `currentRoot`.
        activeView === "live" ? liveRawRootRef.current : cachedSnapshot?.root ?? null,
        hoveredPath,
        cachedRootForView
      ),
    [activeView, cachedRootForView, cachedSnapshot?.root, currentRoot, hoveredPath]
  );
  const issueList = useMemo(() => {
    if (activeView === "live" && activeJob) {
      return activeJob.issues;
    }
    return currentSnapshot?.issues ?? cachedSnapshot?.issues ?? [];
  }, [activeJob, activeView, cachedSnapshot?.issues, currentSnapshot]);

  useEffect(() => {
    if (issueList.length === 0) {
      setIsIssuesModalOpen(false);
    }
  }, [issueList.length]);

  const showViewSwitcher =
    !!cachedSnapshot && (mountState?.cache.state === "stale" || liveAvailable);
  const generatedAt = currentSnapshot?.generatedAt ?? cachedSnapshot?.generatedAt;
  const totals = currentSnapshot?.totals ?? null;
  const progressPercent = Math.min(
    100,
    activeJob?.progress.directoriesDiscovered
      ? (activeJob.progress.directoriesCompleted / activeJob.progress.directoriesDiscovered) * 100
      : 0
  );
  const cacheStatus =
    mountState?.cache.state === "fresh"
      ? "Fresh"
      : mountState?.cache.state === "stale"
        ? "Stale"
        : "Missing";
  const liveStatus = activeJob
    ? activeJob.phase
    : mountState?.cache.state === "fresh"
      ? "Idle"
      : "Preparing";
  const processedBytes = activeJob?.progress.bytesProcessed ?? totals?.totalBytes ?? 0;
  const canStartManualScan =
    !!mount && diskAnalysisQueriesSettled && !mountState?.activeJob;
  // Offered in place of the deleted attach effect. Gated on the job still
  // being in flight so a job that ended without a snapshot event does not get
  // advertised as watchable, and on there being no stream already open.
  const canWatchRunningScan =
    !!mount && !streamPath && !startScanMutation.isPending && isJobActive;
  const manualScanLabel = cachedSnapshot ? "Start New Scan" : "Start Scan";
  const showToolbarActions = canStartManualScan || issueList.length > 0 || isJobActive;
  // B1/B5: a job reaches "partial" when anything made the totals a lower
  // bound. `partialIssueCount` (final whole-branch review, finding 2) is the
  // count scoped to the codes that actually mean that -- `PARTIAL_RESULT_CODES`
  // on the server -- not `issueCount`, which totals every code including
  // `symlink-skipped`, deliberately excluded from partiality because a
  // dropped symlink is not a lower bound on the totals. On an unprivileged
  // scan of a real filesystem, symlinks routinely outnumber the
  // permission-denied directories that actually made the scan partial by one
  // to three orders of magnitude, so quoting `issueCount` here would have
  // overstated the banner by the same margin. `partialIssueCount` carries
  // `.default(0)` on the wire so a snapshot cached before the field existed
  // still parses, and that combination (partial, count 0) is reachable. "0
  // directories were unreadable" would contradict the warning it is attached
  // to, so the count-free wording covers it.
  //
  // Read from two places on purpose. `activeJob.phase` is the only source
  // while a scan is being watched live, but `getMountState` filters
  // `activeJob` to queued/scanning jobs, so the terminal "partial" phase is
  // visible *only* to the client that saw it arrive over SSE. On every
  // subsequent page load -- and after the job is pruned entirely -- the
  // snapshot's own `partial` flag is what is left (B7 review round 1,
  // finding 2).
  const isPartialResult = activeJob?.phase === "partial" || currentSnapshot?.partial === true;
  const partialIssueCount =
    activeJob?.phase === "partial"
      ? activeJob.partialIssueCount
      : (currentSnapshot?.partialIssueCount ?? 0);
  const partialResultMessage =
    partialIssueCount > 0
      ? `${formatCount(partialIssueCount)} directories were unreadable - totals are a lower bound.`
      : "Some directories were unreadable - totals are a lower bound.";

  const openInFiles = (node: DiskAnalysisTreemapNode) => {
    void navigate({
      to: "/files",
      search: getNodeNavigationSearch(node),
    });
  };

  const handleCancelScan = () => {
    if (!activeJob || cancelScanMutation.isPending) {
      return;
    }
    cancelScanMutation.mutate({ mount: activeJob.mount, jobId: activeJob.jobId });
  };

  if (!mount) {
    return (
      <div className="page-container page-container--viewport">
        <div className="page-header">
          <h1 className="page-title">Disk Analysis</h1>
        </div>
        <div className="page-body">
          <div className="panel disk-analysis-empty">
            <div className="disk-analysis-empty__title">Mount metadata missing</div>
            <div className="disk-analysis-empty__body">
              Open disk analysis from `Settings` so the mount and filesystem identity are
              included in the route.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container page-container--viewport">
      <div className="page-header">
        <div className="disk-analysis-toolbar">
          <div className="disk-analysis-toolbar__primary-row">
            <Button
              variant="secondary"
              className="disk-analysis-toolbar__back-button"
              aria-label="Back To Settings"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <ArrowLeft size={14} />
              <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                Back To Settings
              </span>
              <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                Back
              </span>
            </Button>
            {showToolbarActions ? (
              <div className="disk-analysis-toolbar__actions">
                {canStartManualScan ? (
                  <Button
                    aria-label={startScanMutation.isPending ? "Starting Scan" : manualScanLabel}
                    onClick={startManualScan}
                    disabled={startScanMutation.isPending}
                  >
                    <Play size={14} />
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                      {startScanMutation.isPending ? "STARTING..." : manualScanLabel}
                    </span>
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                      {startScanMutation.isPending ? "..." : "Scan"}
                    </span>
                  </Button>
                ) : null}
                {isJobActive ? (
                  <Button
                    variant="secondary"
                    aria-label={cancelScanMutation.isPending ? "Cancelling Scan" : "Cancel Scan"}
                    onClick={handleCancelScan}
                    disabled={cancelScanMutation.isPending}
                  >
                    <X size={14} />
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                      {cancelScanMutation.isPending ? "CANCELLING..." : "Cancel Scan"}
                    </span>
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                      {cancelScanMutation.isPending ? "..." : "Cancel"}
                    </span>
                  </Button>
                ) : null}
                {issueList.length > 0 ? (
                  <Button
                    variant="secondary"
                    aria-label={`View Issues (${formatCount(issueList.length)})`}
                    onClick={() => setIsIssuesModalOpen(true)}
                  >
                    <AlertTriangle size={14} />
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--full">
                      View Issues
                    </span>
                    <span className="disk-analysis-toolbar__label disk-analysis-toolbar__label--compact">
                      Issues
                    </span>
                    <span className="disk-analysis-toolbar__issues-count">
                      ({formatCount(issueList.length)})
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div
            className="disk-analysis-toolbar__mobile-toggle"
            role="group"
            aria-label="Disk analysis mobile view"
          >
            <Button
              type="button"
              className="disk-analysis-toolbar__mobile-toggle-button"
              variant={mobileSidebarOpen ? "primary" : "secondary"}
              aria-pressed={mobileSidebarOpen}
              onClick={() => setMobileSidebarOpen(true)}
            >
              <PanelLeft size={14} />
              <span>Details</span>
            </Button>
            <Button
              type="button"
              className="disk-analysis-toolbar__mobile-toggle-button"
              variant={mobileSidebarOpen ? "secondary" : "primary"}
              aria-pressed={!mobileSidebarOpen}
              onClick={() => setMobileSidebarOpen(false)}
            >
              <span>Treemap</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="page-body disk-analysis-page">
        <div
          className={`disk-analysis-layout${mobileSidebarOpen ? " disk-analysis-layout--mobile-sidebar-open" : ""}`}
        >
          <aside className="panel disk-analysis-sidebar">
            {showViewSwitcher ? (
              <div className="disk-analysis-mode-switch">
                <Button
                  variant={activeView === "cached" ? "primary" : "secondary"}
                  onClick={showCachedView}
                >
                  Cached
                </Button>
                <Button
                  variant={activeView === "live" ? "primary" : "secondary"}
                  onClick={openLiveView}
                  disabled={!liveAvailable}
                >
                  Live
                </Button>
              </div>
            ) : null}

            <div className="disk-analysis-meta">
              <SidebarStat label="Mount" value={getMountLabel(mount.mount)} />
              <SidebarStat label="Cache" value={cacheStatus} />
              <SidebarStat label="Job" value={liveStatus} />
              <SidebarStat label="Generated" value={formatRelativeGeneratedAt(generatedAt)} />
              {streamError ? <SidebarStat label="Stream" value={streamError} tone="bad" /> : null}
              {/* Neutral tone, not "bad" -- attaching to a different scan than
                  expected is a fact worth surfacing, not a failure.
                  `SidebarStat` has no "info" tone of its own, so this omits
                  `tone` for the default, neutral styling. */}
              {streamNotice ? <SidebarStat label="Scan" value={streamNotice} /> : null}
            </div>

            {isPartialResult ? (
              <div className="disk-analysis-partial" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{partialResultMessage}</span>
              </div>
            ) : null}

            {activeJob ? (
              <div className="disk-analysis-progress">
                <div className="disk-analysis-progress__bar">
                  <div
                    className="disk-analysis-progress__fill"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="disk-analysis-progress__meta">
                  <span>
                    {formatCount(activeJob.progress.directoriesCompleted)} /{" "}
                    {formatCount(activeJob.progress.directoriesDiscovered)} directories
                  </span>
                  <span>{formatCount(activeJob.progress.filesDiscovered)} files</span>
                  <span>{formatBytes(processedBytes)} processed</span>
                </div>
              </div>
            ) : null}

            {!isCompactLayout ? (
              <section className="disk-analysis-sidebar-section">
                <div className="label">Hover Details</div>
                <HoverDetails hoveredNode={hoveredNode} />
              </section>
            ) : null}

            <section className="disk-analysis-sidebar-section">
              <div className="label">Extension Legend</div>
              {legend.length > 0 ? (
                <div className="disk-analysis-legend__list">
                  {legend.map((item) => (
                    <LegendRow key={item.extension} item={item} />
                  ))}
                </div>
              ) : (
                <div className="disk-analysis-sidebar-empty">Legend data will appear after scanning.</div>
              )}
              {/* Finding 4, final whole-branch review: a Borg/rsnapshot/`cp -al`
                  backup directory shares storage between copies, and the tree
                  has no other way to say so -- without this, the collapsed
                  count reads like data loss rather than deduplication. */}
              <div className="disk-analysis-sidebar-empty">
                Files that share storage with another copy (hardlinks) are counted once, at their first path.
              </div>
            </section>
          </aside>

          <section className="panel disk-analysis-treemap-panel">

            {mountStateQuery.isLoading || snapshotQuery.isLoading ? (
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">Loading analysis state</div>
                <div className="disk-analysis-empty__body">
                  Reading cached data and active scan status for this mount.
                </div>
              </div>
            ) : mountStateQuery.error || snapshotQuery.error ? (
              <div className="disk-analysis-empty disk-analysis-empty--error">
                <div className="disk-analysis-empty__title">Disk analysis unavailable</div>
                <div className="disk-analysis-empty__body">
                  {mountStateQuery.error?.message ?? snapshotQuery.error?.message}
                </div>
              </div>
            ) : currentRoot ? (
              <TreemapCanvas
                key={mobileSidebarOpen ? "treemap-hidden" : "treemap-visible"}
                root={currentRoot}
                legendByExtension={legendByExtension}
                compactMode={isCompactLayout}
                onHoverNode={setHoveredPath}
                onOpenNode={openInFiles}
              />
            ) : canWatchRunningScan ? (
              // Replaces the deleted attach effect. The page will not join a
              // running scan by itself -- see the DISK-3 note above the view
              // mode effects -- so the offer is a button.
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">A scan is already running</div>
                <div className="disk-analysis-empty__body">
                  This mount is being scanned right now. Watching joins the scan already running
                  and streams the directories as workers finish them.
                </div>
                <Button onClick={startManualScan} disabled={startScanMutation.isPending}>
                  <Play size={14} />
                  <span>
                    {startScanMutation.isPending ? "STARTING..." : "Watch Running Scan"}
                  </span>
                </Button>
              </div>
            ) : activeJob ? (
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">Assembling live tree</div>
                <div className="disk-analysis-empty__body">
                  Streamed directory branches will appear here as workers complete them.
                </div>
              </div>
            ) : (
              // Nothing cached, nothing running. Since the page no longer
              // starts a scan by itself, this is where the user is offered
              // one -- the same action as the toolbar button, named
              // differently so both remain unambiguous to anyone (or any test)
              // resolving them by accessible name.
              <div className="disk-analysis-empty">
                <div className="disk-analysis-empty__title">No analysis data yet</div>
                <div className="disk-analysis-empty__body">
                  Nothing has been scanned for this mount. Scanning walks the whole filesystem,
                  so it only runs when you ask for it.
                </div>
                {canStartManualScan ? (
                  <Button onClick={startManualScan} disabled={startScanMutation.isPending}>
                    <Play size={14} />
                    <span>{startScanMutation.isPending ? "STARTING..." : "Scan This Mount"}</span>
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
      <ScanIssuesModal
        isOpen={isIssuesModalOpen}
        issues={issueList}
        onClose={() => setIsIssuesModalOpen(false)}
      />
    </div>
  );
}
