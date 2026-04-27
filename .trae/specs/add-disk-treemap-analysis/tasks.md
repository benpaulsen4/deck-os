# Tasks
- [x] Task 1: Define the disk analysis contract and architecture
  - [x] Specify the mount identity, scan job lifecycle, SSE event model, cache metadata, and treemap node schema
  - [x] Define worker/resource limit rules, stale-cache behavior, and failure handling for inaccessible paths and partial scans
  - [x] Define the disk-analysis tRPC surface as named query/mutation procedures instead of generic CRUD endpoints
  - [x] Confirm route/deep-link contract between the treemap page and the Files page
- [x] Task 2: Design the server-side scan pipeline
  - [x] Add a dedicated disk-analysis service using bounded multi-worker traversal, branch aggregation, and cancellation support
  - [x] Add APIs for starting/reusing scan jobs, reading cached snapshots, and streaming live updates over SSE
  - [x] Add persistent cache storage and freshness rules for per-disk completed scans, including background regeneration after 24 hours
  - [x] Validate performance constraints with focused service tests around queue limits, cache behavior, and incremental event emission
- [x] Task 3: Design the client-side disk analysis experience
  - [x] Add a Settings action for each disk that opens a dedicated disk analysis page
  - [x] Build the treemap page layout with scan state, stale/live mode switching, extension legend, hover details, and empty/error states
  - [x] Define incremental client-state assembly so streamed branch updates can populate the visualization without blocking on full completion
  - [x] Validate interaction behavior with focused route/component tests for loading, switching between cached/live views, and double-click navigation
- [x] Task 4: Extend the Files page for reveal-in-folder navigation
  - [x] Add route search or equivalent route-driven state for initial folder targeting and file reveal
  - [x] Restore selection/highlight and scroll target file into view after the directory listing resolves
  - [x] Validate deep-link behavior with targeted Files route tests
- [ ] Task 5: Verify the end-to-end feature against the spec
  - [ ] Confirm Settings launch flow, scan/cached/live states, legend coloring, hover behavior, and Files handoff
  - [ ] Confirm stale-cache refresh behavior and SSE progress handling against the checklist

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1 and Task 2
- Task 4 depends on Task 1
- Task 5 depends on Task 2, Task 3, and Task 4
