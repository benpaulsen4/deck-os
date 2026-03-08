# DeckOS v0.2 - File Browser Implementation Plan

## Purpose

This plan is the execution handoff for implementing the File Browser module in phases. It is written so another agent can resume from any phase boundary with clear scope and acceptance criteria.

## Locked Product Decisions

- Files tab is top-level navigation (`Dashboard | Apps | Files | Settings`)
- Files module scope is whole-host filesystem browsing
- Safety model is a fixed protected-path denylist
- Hidden files are behind a toggle and off by default
- Pinned directories are global
- Upload model is simple multipart drag-and-drop
- Download scope is single-file only in v0.2
- File operations include create, rename, delete, copy, and move
- Move must auto-fallback to copy+delete across filesystems
- Text and media open in full-page views with a back button
- Large text files open read-only first with explicit override
- Text save conflict behavior is last-save-wins
- Media preview is direct stream only (range requests, browser codecs)
- PDF viewer is phase 3

## Global Constraints

- Do not change product scope without updating `docs/requirements.md`
- Do not add server-side transcoding in v0.2
- Do not add folder download/archive export in v0.2
- Keep API contracts type-safe and validated
- Enforce denylist consistently for browse/read/write/upload/download paths

## Phase Plan

### Phase 1 - Navigation and Core Browsing

Scope:

- Add Files route and top-bar tab in desktop and mobile navigation
- Add Files page shell: left pane + main pane + path bar
- Implement directory listing flow with hidden-files toggle
- Implement global pinned directories read/write
- Enforce fixed denylist checks for list/stat/navigation operations

Primary deliverables:

- Files route and page component(s)
- Files router/service scaffolding on server
- Core list/stat tRPC procedures
- Global pins persistence mechanism

Acceptance criteria:

- User can open Files tab and navigate host directories
- Path bar supports direct path entry and navigation updates
- Hidden files are excluded by default and shown when enabled
- Denylisted paths return clear blocked-path errors
- Pins persist globally and restore after reload

Resume checkpoint:

- If phase is complete, mark `PHASE 1 COMPLETE` in commit/task notes
- If phase is partial, record exactly which of route, list API, pins, denylist is unfinished

### Phase 2 - File Operations and Transfers

Scope:

- Add icon/table view switch with sorting controls
- Add table metadata columns: name, type, size, modified, created
- Add create/rename/delete/copy/move operations
- Implement cross-filesystem move fallback (copy+delete)
- Implement multipart drag-drop upload
- Implement single-file download action

Primary deliverables:

- Files operations toolbar/context actions
- Mutation procedures for mkdir/rename/copy/move/delete
- Upload and download HTTP routes
- Error model for permission/denied/not-found/conflict

Acceptance criteria:

- User can switch icon/table views without losing current directory
- Table view shows metadata with graceful created-date fallback
- Upload works by drag-and-drop into current directory
- Single-file download works from file actions
- Move across filesystems succeeds with copy+delete fallback

Resume checkpoint:

- If phase is complete, mark `PHASE 2 COMPLETE` in commit/task notes
- If partial, record which operations are verified end-to-end and which are not

### Phase 3 - Full-Page Viewers and Editor

Scope:

- Add full-page text editor/preview with back navigation
- Reuse existing CodeMirror-based editor component style
- Add large-file read-only threshold with explicit override
- Add full-page media viewer/player (image/audio/video)
- Add full-page PDF viewer

Primary deliverables:

- Viewer route(s) and back-navigation state handling
- Text read/write API integration and file-size policy UI
- Media streaming integration with range requests
- PDF rendering integration

Acceptance criteria:

- Text files open/edit/save in full-page mode
- Back button returns user to previous directory context
- Large files open read-only first with explicit override affordance
- Image/audio/video preview works for browser-supported formats
- PDF opens in full-page in-app viewer

Resume checkpoint:

- If phase is complete, mark `PHASE 3 COMPLETE` in commit/task notes
- If partial, record per-viewer completion state (text/media/pdf)

### Phase 4 - Hardening and Stabilization

Scope:

- Harden path normalization and traversal protections
- Validate denylist enforcement across all endpoints
- Improve performance on large directories
- Polish operation feedback, error handling, and loading states
- Add regression tests for critical file operations and safety paths

Primary deliverables:

- Security and resilience fixes
- Performance guardrails and UX polish
- Tests covering critical browse/mutate/stream flows

Acceptance criteria:

- No path traversal or denylist bypass in tested paths
- Large-directory interactions remain responsive
- Key operations have test coverage and pass in CI
- No regressions in existing Dashboard/Apps/Templates flows

Resume checkpoint:

- If phase is complete, mark `PHASE 4 COMPLETE` in commit/task notes
- If partial, record failing tests or unresolved hardening items

## Suggested Workstream Ordering Inside Each Phase

- Backend contracts first
- Client integration second
- Error states and edge cases third
- Verification and regression checks last

## Verification Checklist (Per Phase)

- Run relevant unit/integration tests
- Perform manual happy-path validation in UI
- Validate denied-path behavior and error messaging
- Validate upload/download or stream behavior where applicable
- Confirm no unrelated feature regressions

## Handoff Note Template

Use this template when pausing or handing off:

```
Current phase: <1|2|3|4>
Completion: <percent>
Completed items:
- ...
Remaining items:
- ...
Known issues/blockers:
- ...
Verification performed:
- ...
Next immediate step:
- ...
```
