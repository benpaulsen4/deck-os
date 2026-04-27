# Disk Treemap Analysis Spec

## Why

The Settings page currently shows only mount-level disk utilization percentages, which helps identify that a disk is full but not what is consuming the space. Users need an immediate, visual way to spot the largest folders and files on a selected disk, then jump directly into the file manager to inspect or clean up those items.

## What Changes

- Add a per-disk action in Settings that opens a dedicated storage analysis page for the selected mount.
- Introduce a WizTree-style treemap visualization where folder blocks are sized by recursive disk usage, show a name strip at the top, and file names are revealed on hover.
- Color blocks by file extension for the top 20 most common extensions in the analyzed dataset and show a legend for those mappings.
- Implement on-demand whole-mount disk scans as bounded multi-worker jobs with real-time SSE updates so the client can build the visualization incrementally branch by branch.
- Cache completed scan results per disk and reuse them on later visits.
- When cached data is older than 24 hours, serve the cached result immediately, start a background regeneration, and let the user switch between the stale cached view and the live regenerating view.
- Support double-click actions on treemap blocks that open the Files page at the containing folder and reveal the selected file or folder.

## Impact

- Affected specs: settings storage overview, file browser deep-linking, server job orchestration, streaming updates, disk analysis caching
- Affected code: `packages/client/src/routes/settings.tsx`, `packages/client/src/routes/files.tsx`, client routing/state for a new disk analysis page, `packages/server/src/http/runtimeRoutes.ts`, a new `diskAnalysis` tRPC router namespace with named query/mutation procedures, a new disk-analysis service, shared schema types, and persistence for cached scan artifacts

## ADDED Requirements

### Requirement: Launch Disk Analysis From Settings

The system SHALL provide a per-disk action in Settings that opens a dedicated disk analysis page for the selected mount.

#### Scenario: Open disk analysis

- **WHEN** the user activates the storage analysis action for a disk in Settings
- **THEN** the application opens a dedicated analysis page for that disk
- **AND** the page identifies the selected mount and its cache/scan status before rendering analysis content

### Requirement: Render Treemap Visualization

The system SHALL render analyzed disk contents as a treemap where each node's area is proportional to the recursive file size represented by that node.

#### Scenario: Folder block presentation

- **WHEN** a folder node is visible in the treemap
- **THEN** the block shows a name label on a strip at the top of the block
- **AND** the folder block may contain nested child blocks sized from the analyzed tree

#### Scenario: File block presentation

- **WHEN** a file node is visible in the treemap
- **THEN** the block does not show its name inline by default
- **AND** the UI reveals the file name and metadata on hover or keyboard focus

#### Scenario: Extension coloring and legend

- **WHEN** the analysis data includes file extensions
- **THEN** the client assigns unique colors to the top 20 most common extensions in the analyzed dataset
- **AND** the page renders a legend showing extension-to-color mappings
- **AND** file types outside the top 20 use a shared fallback color treatment

### Requirement: Stream Scan Progress Incrementally

The system SHALL execute disk analysis scans as bounded multi-worker jobs and stream progress updates incrementally to the client using SSE.

#### Scenario: Live scan builds the visualization

- **WHEN** a new disk scan starts
- **THEN** the server emits an initial scan state immediately
- **AND** the server streams branch-level progress updates as workers complete directory analysis
- **AND** the client updates visible progress and integrates new tree branches without waiting for the entire scan to finish

#### Scenario: Resource limits are enforced

- **WHEN** the server schedules disk analysis work
- **THEN** it caps concurrent workers and in-memory pending work according to configured resource limits
- **AND** it degrades gracefully under permission failures, inaccessible paths, symlink edge cases, or transient filesystem errors without terminating the entire scan

### Requirement: Reuse And Refresh Cached Results

The system SHALL cache completed disk analysis results per disk and reuse them on later requests.

#### Scenario: Fresh cached result exists

- **WHEN** the user opens disk analysis for a disk with a cached result younger than 24 hours
- **THEN** the server serves that cached result without starting a foreground rescan

#### Scenario: Stale cached result exists

- **WHEN** the user opens disk analysis for a disk with a cached result older than 24 hours
- **THEN** the server serves the cached result immediately
- **AND** the server begins a background regeneration for that disk
- **AND** the page offers controls to view the completed cached version or switch to the live regenerating version

#### Scenario: No cached result exists

- **WHEN** the user opens disk analysis for a disk with no cached result
- **THEN** the server starts a live scan job
- **AND** the client renders progress updates until a complete result is available

### Requirement: Open Items In File Manager

The system SHALL let users open analyzed folders or reveal analyzed files in the Files page from the treemap.

#### Scenario: Open folder from treemap

- **WHEN** the user double-clicks a folder block in the treemap
- **THEN** the application opens the Files page scoped to that folder path

#### Scenario: Reveal file from treemap

- **WHEN** the user double-clicks a file block in the treemap
- **THEN** the application opens the Files page at the containing folder
- **AND** the application reveals and selects the target file when the Files page loads

### Requirement: Expose Scan Status Clearly

The system SHALL communicate whether the user is viewing cached data, live generated data, or a stale snapshot being refreshed.

#### Scenario: Viewing stale cached data during regeneration

- **WHEN** a background refresh is underway for stale cached data
- **THEN** the page shows that the current view is cached and stale
- **AND** the page shows that a new live scan is in progress
- **AND** the page lets the user switch between the stale cached result and the live-in-progress result

## MODIFIED Requirements

### Requirement: Files Navigation Supports Deep Linking

The Files page SHALL support route-driven initialization so another view can open a folder directly or reveal a file within its containing folder.

#### Scenario: Navigate to folder from another view

- **WHEN** the application navigates to the Files page with a target folder path
- **THEN** the Files page loads that folder as its initial working directory

#### Scenario: Reveal file from another view

- **WHEN** the application navigates to the Files page with a target file path to reveal
- **THEN** the Files page loads the containing folder
- **AND** selects and scrolls the target file into view once the listing is available

## REMOVED Requirements

- None.
