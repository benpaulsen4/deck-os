# Tasks
- [x] Task 1: Finalize the storage analysis architecture and API contract.
  - [x] Add storage-analysis schemas in `packages/server/src/lib/schema.ts` for mount identity, analysis status, freshness metadata, extension histogram, top-20 extension legend, and recursive tree nodes.
  - [x] Define the client route shape for the dedicated analysis page plus the `Files` handoff search parameters: `path`, optional `select`, and optional `open`.
  - [x] Define mount-key generation, cache file paths under `DATA_DIR/storage-analysis`, the 5-minute freshness TTL, and the analysis job states `idle`, `scanning`, `ready`, `stale`, and `failed`.
  - [x] Define the generic analysis strategy, analyzer result metadata, and failure taxonomy for `unsupported`, `permission-denied`, `runtime-failed`, and partial-permission warnings in version 1.

- [x] Task 2: Add server-side storage analysis support.
  - [x] Create `packages/server/src/services/storageAnalysis.ts` to own mount lookup, same-device scan enforcement, snapshot persistence, stale-result serving, and background refresh triggering.
  - [x] Implement the generic Linux-first fallback scan with bounded concurrency using `fs.opendir()` plus metadata calls, ensuring traversal stays on the selected mount by checking device id.
  - [x] Build extension histogram generation, stable top-20 palette assignment, `oversized` result detection, partial-permission warnings, and result serialization for the full recursive hierarchy.
  - [x] Expose the analysis data through validated server procedures or routes with tests for cache hit, stale-while-refresh, permission failure, same-device enforcement, and unsupported-host behavior.

- [x] Task 3: Add the storage analysis UI from `Settings`.
  - [x] Add a per-disk action in `Settings` that opens a dedicated analysis page for the chosen disk.
  - [x] Add the dedicated analysis route shell with loading, stale, oversized, unsupported, and error states plus disk identity, scan freshness, and refresh controls.
  - [x] Add `d3-hierarchy` and build the nested treemap layout from the recursive server result rather than introducing directory drilldown.
  - [x] Render directory header bands with folder names, render file details by tooltip on hover, and render a top-20 extension legend keyed to the server-provided palette.

- [x] Task 4: Connect treemap blocks to the `Files` workflow.
  - [x] Extend `packages/client/src/routes/files.tsx` so it can consume `path`, `select`, and `open` search parameters on first load.
  - [x] Implement treemap double-click behavior so directories open directly in `Files` and files open their parent directory while passing file-selection context.
  - [x] Verify the handoff preserves normal browsing, file selection, and file viewer behavior once the user is in `Files`.

- [x] Task 5: Validate performance and polish the release behavior.
  - [x] Add focused tests around server analysis logic, nested-treemap labeling rules, extension-color legend output, and `Files` handoff behavior.
  - [x] Capture the initial warm-cache, node-budget, and scan-concurrency guardrails in code comments so future profiling work has an explicit starting point.
  - [x] Ensure stale snapshots, slow scans, oversized results, permission failures, and unsupported mounts degrade clearly without freezing the app or blocking `Settings`.
  - [x] Add explicit unsupported and permission-denied UI states so degraded analyzer outcomes are visually distinct from generic loading or failure.

# Task Dependencies
- Task 2 depends on Task 1.
- Task 3 depends on Task 1 and Task 2.
- Task 4 depends on Task 3.
- Task 5 depends on Task 2, Task 3, and Task 4.
