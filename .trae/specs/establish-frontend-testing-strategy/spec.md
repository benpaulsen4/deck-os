# Front-End Testing Strategy Spec

## Why
Backend tests are mature, but the client currently has no automated test suite. A code-driven front-end test plan is required to protect critical user journeys, stateful hooks, and UI interaction logic from regressions.

## What Changes
- Add a complete front-end testing stack for unit, component, integration, and E2E testing.
- Define exact test files and scenarios for all critical routes, hooks, stores, and shared UI controls.
- Add deterministic client test infrastructure (shared render wrapper, network mocking, event-source mocking, fake timers).
- Add CI quality gates for client tests, client coverage, and client build validation.
- Add accessibility, responsive behavior, and failure-state checks as required criteria in critical flows.

## Impact
- Affected specs: Dashboard reliability, apps lifecycle UX, files management UX, settings/security UX, overall release quality.
- Affected code: `packages/client` (new test config and suites), root workspace test scripts, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

## ADDED Requirements
### Requirement: Front-End Test Stack and Harness
The system SHALL provide a first-class front-end test harness in `packages/client` using Vitest + jsdom + Testing Library, with MSW/network mocks and reusable render utilities.

#### Scenario: Local and CI execution are deterministic
- **WHEN** a developer runs client tests locally or CI runs the same suites
- **THEN** tests run with the same setup, mocks, and timing controls
- **AND** flake-prone async flows are controlled by fake timers or explicit waits

### Requirement: Exact Route Test Coverage
The system SHALL include route-level test suites for the following files and scenarios.

#### Scenario: Critical route behaviors are protected
- **WHEN** route suites execute
- **THEN** the following tests exist and pass:
- `src/routes/__tests__/root.auth-gate.test.tsx`
  - shows auth gate while checking/locked
  - renders app shell when unlocked/disabled
- `src/routes/__tests__/dashboard.route.test.tsx`
  - empty state routes to `/apps/templates`
  - app launcher reorder mutation success
  - optimistic reorder rollback on failure
- `src/routes/__tests__/apps.list.route.test.tsx`
  - start/stop/restart call correct mutations
  - delete requires explicit confirmation
  - creation links navigate correctly
- `src/routes/__tests__/apps.new.route.test.tsx`
  - create/deploy blocked when required fields missing
  - pull failure triggers rollback deletion
  - successful flow navigates to app detail
- `src/routes/__tests__/apps.detail.route.test.tsx`
  - safe error/not-found rendering
  - OPEN action allows only http/https links
  - delete confirmation navigates back to list after success
- `src/routes/__tests__/templates.store.route.test.tsx`
  - search debounce and pagination reset behavior
  - empty template state renders correctly
  - deploy links include selected template id
- `src/routes/__tests__/templates.detail.route.test.tsx`
  - deploy-and-start failure rolls back app creation
  - deploy-only mode skips pull/start
  - compose override is sent only when editing is enabled
- `src/routes/__tests__/files.route.test.tsx`
  - large-text read-only protection blocks save until explicitly enabled
  - delete executes only after confirmation and only for selected entries
  - copy/cut/paste logic handles same-path and cut-clipboard clearing
  - row interaction semantics (select/open/double-click) are preserved
  - upload flow posts to upload endpoint and refreshes listing
- `src/routes/__tests__/settings.route.test.tsx`
  - passcode validation blocks invalid submissions before mutation
  - passcode enable/change/session flows emit unauthorized lock event
  - update check/apply states and reload polling behavior are correct

### Requirement: Exact Hook and Store Coverage
The system SHALL include exact hook/store tests for stateful client behavior.

#### Scenario: Client state orchestration remains correct
- **WHEN** hook and store suites execute
- **THEN** the following tests exist and pass:
- `src/hooks/useAppStatus.test.tsx`
  - initial status hydration
  - docker event to status mapping
  - dedupe window handling
  - disabled-mode no-op behavior
- `src/hooks/useAuthGate.test.tsx`
  - initial auth refresh
  - unauthorized event forces lock
  - unlock success/failure handling
  - retry countdown behavior
  - lock action behavior
- `src/hooks/useDockerEvents.test.tsx`
  - event-stream connection lifecycle
  - message parse and callback routing
  - reconnect timer behavior
  - auth-locked error emits unauthorized event
  - unmount cleanup
- `src/hooks/useMetricsStream.test.tsx`
  - metrics event ingestion
  - connection status updates
  - auth-locked error path
  - teardown reset
- `src/hooks/useApiHealth.test.tsx`
  - healthy response marks API connected
  - failure/refetch error marks API disconnected
- `src/hooks/useTRPCErrors.test.ts`
  - path-aware error formatting
  - null/no-op behavior
- `src/stores/appStatus.test.ts`
  - status stack merge and precedence
  - flash lifecycle behavior
- `src/stores/connection.test.ts`
  - channel connect/disconnect and attempts tracking
  - any-connected derived behavior
- `src/stores/metrics.test.ts`
  - bounded metrics history behavior
  - connectivity flag behavior
- `src/stores/toast.test.ts`
  - add/remove behavior
  - id generation fallback behavior

### Requirement: Exact Shared Component Coverage
The system SHALL include tests for shared controls that gate critical UX correctness.

#### Scenario: Shared interaction primitives stay stable
- **WHEN** shared component suites execute
- **THEN** the following tests exist and pass:
- `src/components/auth/PinEntry.test.tsx`
  - digit-only entry/paste behavior
  - keyboard navigation and delete behavior
  - submit-on-enter rules
- `src/components/auth/AuthGateScreen.test.tsx`
  - loading/locked/unlocked rendering rules
  - unlock button enable/disable behavior
  - unlock error and retry messaging
- `src/components/layout/TopBar.test.tsx`
  - power menu open/close interactions
  - confirm flow for restart/shutdown actions
  - lock button visibility and action behavior
- `src/components/ui/ConfirmDialog.test.tsx`
  - close paths (escape/backdrop/close icon)
  - confirm callback and variant rendering
- `src/components/layout/ErrorBoundary.test.tsx`
  - fallback on render errors
  - reset/reload and home-navigation actions
- `src/components/ui/RouteErrorComponent.test.tsx`
  - retry behavior (`reset` vs `router.invalidate`)
  - home navigation behavior
- `src/components/ui/Toast.test.tsx`
  - auto-dismiss timing with hover pause/resume
- `src/components/layout/ToastContainer.test.tsx`
  - duration mapping by toast type
  - close behavior by toast id

### Requirement: E2E Smoke Coverage for Critical Journeys
The system SHALL provide browser-level smoke tests for top business-critical workflows.

#### Scenario: End-to-end regressions are caught before merge
- **WHEN** E2E smoke suite executes
- **THEN** it validates:
- auth gate unlock and app shell access
- app create from template and navigation to detail page
- app start/stop action feedback
- files upload and delete flow with confirmation
- settings passcode change happy path

### Requirement: CI Gates for Front-End Quality
The system SHALL enforce front-end tests and coverage in CI and release pipelines.

#### Scenario: Pull request and release validation
- **WHEN** client code is changed
- **THEN** CI runs client unit/integration suites and client build
- **AND** CI publishes client coverage artifact
- **AND** merge is blocked on test failure

## MODIFIED Requirements
### Requirement: Quality Assurance Scope
Quality assurance SHALL include both backend and frontend automated tests, with front-end route/state/UI behavior considered mandatory before merge.

## REMOVED Requirements
### Requirement: None
**Reason**: This change expands coverage and removes no existing requirement.
**Migration**: Not applicable.
