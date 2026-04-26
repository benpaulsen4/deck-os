# Storage Treemap Spec

## Why
DeckOS currently shows disk utilization totals in `Settings`, but it does not help the user quickly identify which folders and files are consuming that space. A WizTree-style treemap gives an immediate visual answer and should connect directly into the existing `Files` workflow so users can inspect or clean up large paths without leaving the app context.

## What Changes
- Add a per-disk `Analyze` action to the disk list in `Settings`.
- Add a dedicated storage analysis view for a selected disk or mount.
- Render a treemap where block area reflects on-disk size for folders and files.
- Render the full recursive hierarchy concurrently in a single nested treemap, with parent directory rectangles containing all descendant rectangles.
- Show directory names directly in each directory header band and show file names by hover tooltip.
- Apply stable color coding for the top 20 most common file extensions in the analyzed result, with a fallback color for directories, extensionless files, and extensions outside the top 20.
- Allow double-click on a treemap block to open the corresponding folder or file in the `Files` page.
- Add a server-side storage analysis pipeline that is optimized for Linux-first hosts, reuses cached snapshots, and avoids unnecessary repeat rescans.
- Define a degraded behavior for cold scans, permission failures, and oversized result sets, including clear status messaging and refresh controls.

## Implementation Strategy
- Client route: add a dedicated route such as `packages/client/src/routes/storage.$mountId.tsx` so the treemap has full-screen space and can be deep-linked from `Settings`.
- Settings launch: extend `packages/client/src/routes/settings.tsx` disk rows with an `Analyze` button that navigates with a stable mount identifier derived from mount path plus filesystem name.
- Files handoff: extend `packages/client/src/routes/files.tsx` to accept search parameters for `path`, optional `select`, and optional `open`, so double-click from the treemap can open a directory, preselect a file, or open the file viewer directly.
- Shared schemas: add storage-analysis request and response schemas in `packages/server/src/lib/schema.ts` and mirror their usage through the existing tRPC surface rather than introducing ad hoc client fetches.
- Server service: add `packages/server/src/services/storageAnalysis.ts` as the single owner of scan jobs, cache metadata, result serialization, and mount-boundary enforcement.
- Analyzer strategy: version 1 uses a single generic same-device analyzer with warm-cache reuse rather than a filesystem-specific fast path.
- Job model: create one analysis job per mount key; job states are `idle`, `scanning`, `ready`, `stale`, and `failed`; a ready job can be served immediately while a background refresh updates it.
- Cache location: persist snapshots under `DATA_DIR/storage-analysis/<mount-key>.json` plus a small metadata file containing `startedAt`, `completedAt`, `rootPath`, `deviceId`, `nodeCount`, `totalSize`, and `extensionHistogram`.
- Mount targeting: identify the selected disk from the existing `systeminformation.fsSize()` output, then resolve the scan root to the mount path shown in `Settings`; for Linux, enforce same-device traversal by comparing each entry's `st_dev` to the root device so the scan does not cross into other mounted filesystems.
- Filesystem detection: determine the filesystem type for the selected mount up front and record it in job metadata so the analyzer-selection path is visible in logs, tests, and UI diagnostics.
- Analyzer order: attempt analyzers in this order for each mount: `warm-cache reuse`, then the generic bounded-concurrency same-device scan.
- Generic scan strategy: run a bounded-concurrency recursive scanner using `fs.opendir()` plus `Dirent` and `lstat()`/`stat()`, batching directory reads and file metadata collection to reduce event-loop blocking.
- Warm-open strategy: if a cached snapshot exists and is younger than the freshness TTL, return it immediately; if it is older than the TTL, return it as `stale` immediately and start a background refresh without blocking the page.
- Freshness TTL: set the initial freshness threshold to 5 minutes for hot reuse and mark anything older as stale but still viewable until a refresh completes.
- Linux-first performance note: version 1 ships only the generic analyzer plus cache reuse; a future spec can add filesystem-specific fast paths only after they are proven and worth the added complexity.
- Tree shape: every node in the stored result includes `path`, `name`, `type`, `size`, `extension`, `childCount`, and `children`; directory `size` equals the sum of all descendants so rectangles can nest correctly without a separate drilldown mode.
- Result budget: include every directory in the hierarchy and every file needed for layout; if node count exceeds a defined safety ceiling, the analysis still completes but the response includes an `oversized` flag so the UI can warn about degraded responsiveness before rendering.
- Extension colors: compute a histogram across all files in the result, sort descending by count then total bytes, keep the top 20 extensions, and assign each one a deterministic palette slot; all non-top-20 extensions share a neutral fallback file color.
- Treemap layout: add `d3-hierarchy` on the client and use its squarified treemap layout to compute nested rectangles from the server-provided hierarchy; perform layout client-side so cached server snapshots remain layout-agnostic.
- Visual rules: reserve a small header strip on directory rectangles for the folder name, clip long names with ellipsis, suppress text on rectangles below a minimum pixel height, and show file details via tooltip on hover.
- Interaction rules: single click selects/highlights a block, double-click on a directory opens that path in `Files`, and double-click on a file opens `Files` with the parent directory active and the file passed as `select` plus `open`.
- Rendering guardrails: use a minimum visible area threshold for interactive hit targets, virtualize tooltips/highlights rather than DOM-rendering one overlay per node, and keep the treemap inside a single canvas or SVG-backed component tree chosen during implementation based on profiling.
- Validation: add server tests for mount scoping, cache reuse, stale-result serving, extension histogram generation, and permission handling; add client tests for the `Analyze` launch action, nested treemap labeling rules, tooltip behavior, extension legend, and `Files` handoff search parameters.

## Impact
- Affected specs: system settings, disk metrics, file browser navigation, host filesystem analysis
- Affected code: `packages/client/src/routes/settings.tsx`, new storage analysis client route and treemap components, `packages/client/src/routes/files.tsx`, `packages/server/src/lib/schema.ts`, new `packages/server/src/services/storageAnalysis.ts`, server router/procedure wiring, any shared query/state for file navigation

## ADDED Requirements
### Requirement: Launch Disk Analysis
The system SHALL allow the user to launch a storage analysis view for an individual disk entry shown in `Settings`.

#### Scenario: Open analysis for a disk
- **WHEN** the user activates the disk analysis action for a disk entry
- **THEN** DeckOS opens a dedicated storage analysis view scoped to that disk or mount
- **AND** the view shows which disk is being analyzed
- **AND** the view starts loading storage visualization data for that disk

### Requirement: Render Treemap Visualization
The system SHALL render a WizTree-style nested treemap visualization of storage usage for the selected disk without requiring directory drilldown to reveal descendant content.

#### Scenario: Render successful analysis
- **WHEN** storage analysis data is available
- **THEN** the view shows folders and files as blocks
- **AND** each block's rendered area reflects its relative on-disk size within the current scope
- **AND** directory blocks recursively contain their descendant directory and file blocks
- **AND** directory blocks show the directory name in a visible header area
- **AND** file blocks expose name, full path, extension, and size through hover tooltip
- **AND** directories and files remain visually distinguishable

#### Scenario: Apply extension colors
- **WHEN** analysis data is prepared for rendering
- **THEN** DeckOS identifies the 20 most common file extensions in the analyzed result
- **AND** those extensions receive stable distinct colors in the treemap and legend
- **AND** files outside that top-20 set use a fallback color
- **AND** directory blocks use a separate directory styling treatment

### Requirement: Fast Analysis Strategy
The system SHALL prioritize fast storage analysis and avoid making the user wait for slow, repeated full-volume traversal during normal use.

#### Scenario: Open from warm cache
- **WHEN** a recent snapshot already exists for the selected disk
- **THEN** DeckOS returns the cached hierarchy immediately
- **AND** the treemap can render without waiting for a new full scan
- **AND** the result includes freshness metadata

#### Scenario: Generic analyzer is used
- **WHEN** the selected disk is analyzed in version 1
- **THEN** DeckOS uses the bounded-concurrency same-device scan for that mount
- **AND** the result metadata identifies that the generic analyzer produced the snapshot
- **AND** the UI can communicate stale data, oversized output, skipped paths, and hard failures clearly

#### Scenario: Serve stale while refreshing
- **WHEN** a snapshot exists but is older than the freshness threshold
- **THEN** DeckOS serves that snapshot as stale immediately
- **AND** DeckOS starts a background refresh
- **AND** the UI indicates that fresher data is being prepared

### Requirement: File Manager Handoff
The system SHALL let the user move from a treemap block into the `Files` page for follow-up actions.

#### Scenario: Open directory in file manager
- **WHEN** the user double-clicks a directory block in the treemap
- **THEN** DeckOS navigates to the `Files` page
- **AND** the file browser opens with that directory as the active path

#### Scenario: Open file in file manager
- **WHEN** the user double-clicks a file block in the treemap
- **THEN** DeckOS navigates to the `Files` page
- **AND** the file browser opens the file's parent directory
- **AND** the clicked file is selected or opened in the file workflow

### Requirement: Technical Determinism
The plan SHALL define the implementation structure precisely enough that a future agent can build the feature without inventing core architecture decisions.

#### Scenario: Future implementation follows the plan
- **WHEN** an implementation agent begins work from this spec
- **THEN** the agent can identify the target route shape, server service boundary, cache location, job states, result schema, extension-color rule, degraded-state contract, and `Files` handoff contract directly from the plan
- **AND** the agent does not need to guess whether the feature uses drilldown, nested rendering, extension-based coloring, or filesystem-specific fast paths in version 1

### Requirement: Analysis State And Failure Handling
The system SHALL communicate analysis progress, stale results, and failures in a way that keeps the feature understandable and safe to use.

#### Scenario: Analysis is running
- **WHEN** the server is still preparing treemap data
- **THEN** the client shows an in-progress state with the selected disk context
- **AND** the user can leave the page or retry later without affecting the rest of the app

#### Scenario: Analysis fails
- **WHEN** analysis cannot complete because of permissions, unsupported filesystem behavior, or internal errors
- **THEN** DeckOS shows a non-blocking error state
- **AND** the rest of `Settings` and `Files` remains usable
- **AND** the error messaging explains whether retrying is likely to help

## MODIFIED Requirements
### Requirement: Settings Disk Overview
The `Settings` disk overview SHALL continue to show quick per-disk capacity information while also exposing entry points into deeper storage analysis.

#### Scenario: Disk list remains scannable
- **WHEN** the `Settings` page renders disk information
- **THEN** each disk entry still shows mount, filesystem, used space, total space, and free space
- **AND** the added analysis action does not remove the existing quick-overview behavior

### Requirement: Files Route Navigation
The `Files` page SHALL support direct navigation from other app surfaces using an explicit target path context.

#### Scenario: Arrive from storage analysis
- **WHEN** the user enters `Files` from the storage analysis view
- **THEN** the route accepts the target path context needed to open the correct directory
- **AND** the route can optionally accept a file path to preselect or open after navigation
- **AND** the page preserves existing browsing behavior after the handoff completes

## REMOVED Requirements
- None.
