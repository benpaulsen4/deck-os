import { describe, expect, it } from "vitest";
import {
  createSyntheticLiveRoot,
  integrateBranchIntoTree,
} from "./diskAnalysisClient";
import type { DiskAnalysisMountIdentity, DiskAnalysisTreemapNode } from "../../../server/src/lib/diskAnalysisContract.js";

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
});
