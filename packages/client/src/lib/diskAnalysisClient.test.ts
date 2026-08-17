import { describe, expect, it } from "vitest";
import {
  createNodeIndex,
  createPresentationTree,
  createSnapshotPresentationTree,
  createSyntheticLiveRoot,
  describeCancelScanError,
  describeScanStartError,
  findNodeByPath,
  getEventMountIdentity,
  getMountStatePollIntervalMs,
  integrateBranchIntoTree,
  resolveHoveredNode,
} from "./diskAnalysisClient";
import type {
  DiskAnalysisJobState,
  DiskAnalysisMountIdentity,
  DiskAnalysisMountState,
  DiskAnalysisTreemapNode,
} from "@deckos/contracts";

function makeDirectory(path: string, children: DiskAnalysisTreemapNode[] = []): DiskAnalysisTreemapNode {
  return {
    path,
    name: path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path,
    type: "directory",
    size: 0,
    recursiveSize: children.reduce((sum, child) => sum + child.recursiveSize, 0),
    extension: null,
    childCount: children.length,
    descendantsScanned: children.filter((child) => child.type === "directory").length,
    truncated: false,
    issues: [],
    children,
  };
}

function makeFile(path: string, size: number): DiskAnalysisTreemapNode {
  return {
    path,
    name: path.split(/[\\/]/).at(-1) || path,
    type: "file",
    size,
    recursiveSize: size,
    extension: "txt",
    childCount: 0,
    descendantsScanned: 0,
    truncated: false,
    issues: [],
    children: [],
  };
}

describe("diskAnalysisClient", () => {
  it("prunes cyclic or self-referential streamed branches", () => {
    const mount: DiskAnalysisMountIdentity = { mount: "C:\\", fs: "ntfs" };
    const root = createSyntheticLiveRoot(mount);
    const cyclicBranch = makeDirectory("C:\\media", [
      makeDirectory("C:\\media", [makeFile("C:\\media\\loop.txt", 10)]),
      makeDirectory("C:\\media\\videos", [makeFile("C:\\media\\videos\\clip.txt", 20)]),
    ]);

    const integrated = integrateBranchIntoTree(root, mount, cyclicBranch);
    const media = integrated.children.find((child) => child.path === "C:\\media");

    expect(media).toBeDefined();
    expect(media?.children.some((child) => child.path === "C:\\media")).toBe(false);
    expect(media?.children.some((child) => child.path === "C:\\media\\videos")).toBe(true);
  });

  it("integrates deep live branches without recursive stack overflow", () => {
    const mount: DiskAnalysisMountIdentity = { mount: "C:\\", fs: "ntfs" };
    let root = createSyntheticLiveRoot(mount);
    const maxDepth = 800;

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const segments = Array.from({ length: depth }, (_, index) => `d${index + 1}`);
      const branchPath = `C:\\${segments.join("\\")}`;
      const childPath = `${branchPath}\\leaf.txt`;
      root = integrateBranchIntoTree(
        root,
        mount,
        makeDirectory(branchPath, [makeFile(childPath, depth)])
      );
    }

    expect(root.children.some((child) => child.path === "C:\\d1")).toBe(true);
  });

  it("builds a pruned presentation tree with an aggregate bucket for tiny siblings", () => {
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\games", [makeFile("C:\\games\\huge.bin", 8_000)]),
      ...Array.from({ length: 60 }, (_, index) =>
        makeFile(`C:\\tiny-${index}.txt`, 10)
      ),
    ]);

    const presentation = createPresentationTree(root, {
      maxDepth: 3,
      maxChildrenPerDirectory: 12,
      minShareByDepth: [0, 0.02, 0.01],
    });

    expect(presentation).not.toBeNull();
    expect(
      presentation?.children.some((child) => child.path === "C:\\games")
    ).toBe(true);
    expect(
      presentation?.children.some((child) => child.path.endsWith("__deckos_other_entries__"))
    ).toBe(true);
  });

  // The first 24 children at depth 0 are force-kept regardless of size, so a
  // case with only a handful of entries hides nothing at all. These build past
  // that floor so the hidden path is genuinely exercised.
  const withTrailingSmallEntries = (count: number) =>
    makeDirectory("C:\\", [
      ...Array.from({ length: 24 }, (_, index) =>
        makeDirectory(`C:\\big-${index}`, [makeFile(`C:\\big-${index}\\data.bin`, 8_000)])
      ),
      ...Array.from({ length: count }, (_, index) =>
        makeDirectory(`C:\\small-${index}`, [makeFile(`C:\\small-${index}\\note.txt`, 5)])
      ),
    ]);

  const presentationOptions = {
    maxDepth: 3,
    maxChildrenPerDirectory: 12,
    minShareByDepth: [0, 0.02, 0.01],
  };

  it("renders a lone hidden entry as itself instead of an Other bucket", () => {
    const presentation = createPresentationTree(withTrailingSmallEntries(1), presentationOptions);

    expect(presentation?.children.some((child) => child.path === "C:\\small-0")).toBe(true);
    expect(
      presentation?.children.some((child) => child.path.endsWith("__deckos_other_entries__"))
    ).toBe(false);
  });

  it("still buckets when more than one entry is hidden", () => {
    const presentation = createPresentationTree(withTrailingSmallEntries(2), presentationOptions);

    expect(presentation?.children.some((child) => child.path === "C:\\small-0")).toBe(false);
    expect(
      presentation?.children.some((child) => child.path.endsWith("__deckos_other_entries__"))
    ).toBe(true);
  });

  it("keeps deep-but-significant directories instead of collapsing them", () => {
    // Six levels below the root, which the previous ceiling of 4 collapsed
    // into "Other" regardless of size.
    const deepFile = makeFile("C:\\a\\b\\c\\d\\e\\deep.bin", 1_000);
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\a", [
        makeDirectory("C:\\a\\b", [
          makeDirectory("C:\\a\\b\\c", [
            makeDirectory("C:\\a\\b\\c\\d", [makeDirectory("C:\\a\\b\\c\\d\\e", [deepFile])]),
          ]),
        ]),
      ]),
    ]);

    const presentation = createPresentationTree(root);

    expect(findNodeByPath(presentation, "C:\\a\\b\\c\\d\\e")?.path).toBe("C:\\a\\b\\c\\d\\e");
  });

  it("stops descending a single-child chain at the depth ceiling", () => {
    // Promoting a lone hidden child must not walk an arbitrarily deep chain --
    // `node_modules` nesting would otherwise recurse without bound.
    let node = makeFile("C:\\chain\\1\\2\\3\\4\\5\\6\\7\\8\\deep.bin", 1_000);
    for (const path of [
      "C:\\chain\\1\\2\\3\\4\\5\\6\\7\\8",
      "C:\\chain\\1\\2\\3\\4\\5\\6\\7",
      "C:\\chain\\1\\2\\3\\4\\5\\6",
      "C:\\chain\\1\\2\\3\\4\\5",
      "C:\\chain\\1\\2\\3\\4",
      "C:\\chain\\1\\2\\3",
      "C:\\chain\\1\\2",
      "C:\\chain\\1",
      "C:\\chain",
    ]) {
      node = makeDirectory(path, [node]);
    }
    const presentation = createPresentationTree(makeDirectory("C:\\", [node]));

    const measureDepth = (n: DiskAnalysisTreemapNode | null, depth = 0): number =>
      !n || n.children.length === 0
        ? depth
        : Math.max(...n.children.map((child) => measureDepth(child, depth + 1)));

    // maxDepth 6, plus at most one promoted leaf past the ceiling.
    expect(measureDepth(presentation)).toBeLessThanOrEqual(8);
  });

  it("trusts newer shallow branch sizes over older preserved live totals", () => {
    const mount: DiskAnalysisMountIdentity = { mount: "C:\\", fs: "ntfs" };
    let root = createSyntheticLiveRoot(mount);

    root = integrateBranchIntoTree(
      root,
      mount,
      makeDirectory("C:\\Users", [makeDirectory("C:\\Users\\benp", [makeFile("C:\\Users\\benp\\a.txt", 700)])])
    );

    root = integrateBranchIntoTree(
      root,
      mount,
      {
        ...makeDirectory("C:\\Users", []),
        recursiveSize: 300,
        childCount: 1,
        children: [
          {
            ...makeDirectory("C:\\Users\\benp", []),
            recursiveSize: 300,
            childCount: 1,
            children: [],
          },
        ],
      }
    );

    const users = root.children.find((child) => child.path === "C:\\Users");
    const benp = users?.children.find((child) => child.path === "C:\\Users\\benp");

    expect(users?.recursiveSize).toBe(300);
    expect(benp?.recursiveSize).toBe(300);
    expect(benp?.children.some((child) => child.path === "C:\\Users\\benp\\a.txt")).toBe(true);
  });

  it("resolves hovered synthetic aggregate buckets from the presentation tree before raw data", () => {
    const rawRoot = makeDirectory("C:\\", [
      ...Array.from({ length: 50 }, (_, index) => makeFile(`C:\\tiny-${index}.txt`, 10)),
    ]);
    const presentationRoot = createPresentationTree(rawRoot, {
      maxDepth: 3,
      maxChildrenPerDirectory: 8,
      minShareByDepth: [0, 0.02, 0.01],
    });
    const aggregateBucket = presentationRoot?.children.find((child) =>
      child.path.endsWith("__deckos_other_entries__")
    );

    expect(aggregateBucket).toBeDefined();
    expect(resolveHoveredNode(presentationRoot, rawRoot, aggregateBucket?.path ?? null)).toEqual(
      aggregateBucket
    );
  });

  it("does not grow a phantom root when the mount path carries a trailing separator", () => {
    // The server normalizes the mount path (`path.resolve`) before it names
    // the root node or any branch, but the page builds its mount identity from
    // the raw `?mount=` search param. When the two disagree, no branch ever
    // equals `mount.mount`, so the ancestor chain walks all the way to `/` and
    // hangs the entire live tree under a phantom node -- one level too deep,
    // and with the real mount appearing as its own grandchild.
    const mount: DiskAnalysisMountIdentity = { mount: "/var/lib/", fs: "ext4" };
    const root = createSyntheticLiveRoot(mount);
    const integrated = integrateBranchIntoTree(
      root,
      mount,
      makeDirectory("/var/lib/docker", [makeFile("/var/lib/docker/image.img", 4096)])
    );

    expect(integrated.path).toBe("/var/lib");
    expect(integrated.children.map((child) => child.path)).toEqual(["/var/lib/docker"]);
    expect(integrated.children.some((child) => child.path === "/")).toBe(false);
  });

  it("names aggregate buckets with the separator the tree already uses", () => {
    // The bucket path is hardcoded with a backslash, so on a Linux box every
    // synthetic "Other" node is named `/var/lib\__deckos_other_entries__` --
    // a path no other part of the system can match or navigate from.
    const root = makeDirectory("/var/lib", [
      makeDirectory("/var/lib/docker", [makeFile("/var/lib/docker/image.img", 8_000)]),
      ...Array.from({ length: 60 }, (_, index) => makeFile(`/var/lib/tiny-${index}.txt`, 10)),
    ]);

    const presentation = createPresentationTree(root, {
      maxDepth: 3,
      maxChildrenPerDirectory: 12,
      minShareByDepth: [0, 0.02, 0.01],
    });
    const bucket = presentation?.children.find((child) =>
      child.path.endsWith("__deckos_other_entries__")
    );

    expect(bucket?.path).toBe("/var/lib/__deckos_other_entries__");
    expect(bucket?.path).not.toContain("\\");
  });

  it("joins aggregate bucket paths onto a drive root without doubling the separator", () => {
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\games", [makeFile("C:\\games\\huge.bin", 8_000)]),
      ...Array.from({ length: 60 }, (_, index) => makeFile(`C:\\tiny-${index}.txt`, 10)),
    ]);

    const presentation = createPresentationTree(root, {
      maxDepth: 3,
      maxChildrenPerDirectory: 12,
      minShareByDepth: [0, 0.02, 0.01],
    });
    const bucket = presentation?.children.find((child) =>
      child.path.endsWith("__deckos_other_entries__")
    );

    expect(bucket?.path).toBe("C:\\__deckos_other_entries__");
  });

  it("leaves a small snapshot tree exactly as the server sent it", () => {
    // Pruning has to reach cached and completed snapshots so the treemap never
    // receives an unpruned half-million-node root -- but a small tree must
    // come through untouched, or applying it silently changes what every
    // existing user sees on a perfectly renderable scan.
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\games", [makeFile("C:\\games\\huge.bin", 8_000)]),
      ...Array.from({ length: 60 }, (_, index) => makeFile(`C:\\tiny-${index}.txt`, 10)),
    ]);

    expect(createSnapshotPresentationTree(root)).toBe(root);
  });

  it("prunes a snapshot tree once it is too large to render", () => {
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\games", [makeFile("C:\\games\\huge.bin", 8_000_000)]),
      ...Array.from({ length: 30_000 }, (_, index) => makeFile(`C:\\tiny-${index}.txt`, 10)),
    ]);

    const pruned = createSnapshotPresentationTree(root);

    expect(pruned).not.toBe(root);
    expect(pruned?.children.length).toBeLessThan(root.children.length);
    expect(pruned?.children.some((child) => child.path === "C:\\games")).toBe(true);
    expect(
      pruned?.children.some((child) => child.path.endsWith("__deckos_other_entries__"))
    ).toBe(true);
  });

  it("indexes a root by path once so hover lookups stop re-walking the tree", () => {
    const root = makeDirectory("C:\\", [
      makeDirectory("C:\\games", [makeFile("C:\\games\\huge.bin", 8_000)]),
    ]);

    const index = createNodeIndex(root);

    expect(index.get("C:\\")).toBe(root);
    expect(index.get("C:\\games\\huge.bin")?.recursiveSize).toBe(8_000);
    expect(index.size).toBe(3);
  });

  it("does not serve a stale path index after a rescan replaces the root", () => {
    // The index is cached against the root *object*, not the mount path: a
    // rescan produces a brand new root that reuses every path, so any key that
    // is merely "stable" (the mount, the root's path) hands back the previous
    // scan's nodes forever.
    const first = makeDirectory("C:\\", [makeFile("C:\\report.log", 100)]);
    expect(findNodeByPath(first, "C:\\report.log")?.recursiveSize).toBe(100);

    const second = makeDirectory("C:\\", [makeFile("C:\\report.log", 999)]);
    expect(findNodeByPath(second, "C:\\report.log")?.recursiveSize).toBe(999);
  });

  it("tells a refused path apart from a busy scanner when a scan will not start", () => {
    expect(
      describeScanStartError({
        message: "Disk analysis refuses to scan /proc",
        data: { code: "FORBIDDEN" },
      })
    ).toBe("This path cannot be scanned: Disk analysis refuses to scan /proc");

    expect(
      describeScanStartError({
        message: "A previous scan of /data is still winding down",
        data: { code: "CONFLICT" },
      })
    ).toBe(
      "Something else is scanning right now - try again shortly. A previous scan of /data is still winding down"
    );

    expect(describeScanStartError(new Error("socket hang up"))).toBe("socket hang up");
    expect(describeScanStartError(null)).toBe("Failed to start disk analysis scan");
  });

  it("describes a genuine cancelScan failure without inventing scan-start wording", () => {
    // cancelScan has no FORBIDDEN/CONFLICT mapping on the server (it never
    // throws -- see packages/server/src/routers/diskAnalysis.ts) so a
    // rejection here is always transport/auth level, not a refused path or a
    // busy scanner. Reusing describeScanStartError's wording for it would
    // claim "This path cannot be scanned" for an error that has nothing to do
    // with the path.
    expect(describeCancelScanError(new Error("socket hang up"))).toBe("socket hang up");
    expect(describeCancelScanError(null)).toBe("Failed to cancel scan");
  });

  it("keeps a POSIX bucket path POSIX even when a directory name contains a backslash", () => {
    // A backslash is a legal character in a POSIX filename. Sniffing the
    // *last* separator in the path therefore picked `\` for
    // `/data/back\slash` and produced a bucket nothing could navigate from.
    // The separator follows the shape of the path's root, not its contents.
    const root = makeDirectory("/data/back\\slash", [
      makeDirectory("/data/back\\slash/big", [makeFile("/data/back\\slash/big/huge.bin", 8_000)]),
      ...Array.from({ length: 60 }, (_, index) =>
        makeFile(`/data/back\\slash/tiny-${index}.txt`, 10)
      ),
    ]);

    const presentation = createPresentationTree(root, {
      maxDepth: 3,
      maxChildrenPerDirectory: 12,
      minShareByDepth: [0, 0.02, 0.01],
    });
    const bucket = presentation?.children.find((child) =>
      child.path.endsWith("__deckos_other_entries__")
    );

    expect(bucket?.path).toBe("/data/back\\slash/__deckos_other_entries__");
  });

  it("takes the mount identity off whichever scan event carries one", () => {
    // The page builds its mount from the raw `?mount=` search param, which the
    // server has already run through `path.resolve`. Only the events know the
    // resolved form, and each event shape puts it somewhere different --
    // getting one of them wrong silently reinstates the phantom-root bug for
    // that event type alone.
    const mount: DiskAnalysisMountIdentity = { mount: "/data/media", fs: "ext4" };
    const job = { mount } as DiskAnalysisJobState;

    expect(getEventMountIdentity({ event: "status", job })).toEqual(mount);
    expect(getEventMountIdentity({ event: "progress", job })).toEqual(mount);
    expect(
      getEventMountIdentity({
        event: "branch",
        jobId: "11111111-1111-1111-1111-111111111111",
        mount,
        branch: makeDirectory("/data/media/videos"),
      })
    ).toEqual(mount);
    expect(
      getEventMountIdentity({
        event: "snapshot",
        job,
        snapshot: { mount } as never,
      })
    ).toEqual(mount);

    // A keepalive carries a job id and nothing else, so there is nothing to
    // adopt and the caller must keep what it had.
    expect(
      getEventMountIdentity({
        event: "keepalive",
        jobId: "11111111-1111-1111-1111-111111111111",
      })
    ).toBeNull();
  });

  it("polls the mount state only while a job is actually running", () => {
    // B7 review round 2, finding 3. `mountStateQuery` has no refetch trigger
    // of its own -- no `refetchInterval`, and `refetchOnWindowFocus` is off
    // globally -- so once a job ends, "Watch Running Scan" keeps advertising
    // it for as long as the tab stays open with nothing to correct the stale
    // read. Polling only while a job is reported active fixes that without
    // introducing a timer that outlives the thing it is watching.
    const mount: DiskAnalysisMountIdentity = { mount: "C:\\", fs: "ntfs" };
    const runningJob = { mount, phase: "scanning" } as DiskAnalysisJobState;
    const running: DiskAnalysisMountState = {
      mount,
      cache: { state: "missing" },
      activeJob: runningJob,
    };
    const idle: DiskAnalysisMountState = {
      mount,
      cache: { state: "missing" },
      activeJob: null,
    };

    expect(getMountStatePollIntervalMs(running)).toBeGreaterThan(0);
    expect(getMountStatePollIntervalMs(idle)).toBe(false);
    expect(getMountStatePollIntervalMs(undefined)).toBe(false);
  });
});
