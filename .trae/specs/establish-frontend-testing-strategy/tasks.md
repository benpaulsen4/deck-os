# Tasks
- [x] Task 1: Establish the client test foundation and scripts.
  - [x] SubTask 1.1: Add client test dependencies and `test`, `test:watch`, `test:coverage` scripts in `packages/client/package.json`.
  - [x] SubTask 1.2: Add client Vitest config and shared setup utilities (jsdom, testing-library, jest-dom, mock reset).
  - [x] SubTask 1.3: Add shared test helpers for router-aware rendering, API mocking, and event-source mocking.

- [x] Task 2: Implement hook and store suites for state orchestration.
  - [x] SubTask 2.1: Add `src/hooks/useAuthGate.test.tsx`, `useDockerEvents.test.tsx`, `useMetricsStream.test.tsx`, `useAppStatus.test.tsx`, and `useApiHealth.test.tsx`.
  - [x] SubTask 2.2: Add `src/hooks/useTRPCErrors.test.ts`.
  - [x] SubTask 2.3: Add `src/stores/appStatus.test.ts`, `connection.test.ts`, `metrics.test.ts`, and `toast.test.ts`.

- [x] Task 3: Implement shared component suites for interaction safety.
  - [x] SubTask 3.1: Add auth component tests (`PinEntry.test.tsx`, `AuthGateScreen.test.tsx`).
  - [x] SubTask 3.2: Add layout and dialog tests (`TopBar.test.tsx`, `ErrorBoundary.test.tsx`, `ConfirmDialog.test.tsx`, `RouteErrorComponent.test.tsx`).
  - [x] SubTask 3.3: Add toast behavior tests (`Toast.test.tsx`, `ToastContainer.test.tsx`).

- [ ] Task 4: Implement route suites for dashboard and apps workflows.
  - [ ] SubTask 4.1: Add `src/routes/__tests__/root.auth-gate.test.tsx` and `dashboard.route.test.tsx`.
  - [ ] SubTask 4.2: Add `apps.list.route.test.tsx`, `apps.new.route.test.tsx`, and `apps.detail.route.test.tsx`.
  - [ ] SubTask 4.3: Add `templates.store.route.test.tsx` and `templates.detail.route.test.tsx`.

- [ ] Task 5: Implement route suites for files and settings workflows.
  - [ ] SubTask 5.1: Add `src/routes/__tests__/files.route.test.tsx` covering selection, copy/cut/paste, upload, delete confirmation, and read-only editor behavior.
  - [ ] SubTask 5.2: Add `src/routes/__tests__/settings.route.test.tsx` covering passcode validation, lock-event emission, and update flow states.

- [ ] Task 6: Add critical E2E smoke journeys.
  - [ ] SubTask 6.1: Add auth unlock and shell-access smoke test.
  - [ ] SubTask 6.2: Add template deploy and app start/stop smoke test.
  - [ ] SubTask 6.3: Add files upload/delete and settings passcode smoke test.

- [ ] Task 7: Enforce CI gates and document contributor workflow.
  - [ ] SubTask 7.1: Update `.github/workflows/ci.yml` to run client tests, client build, and client coverage artifact upload.
  - [ ] SubTask 7.2: Update `.github/workflows/release.yml` to include client tests in release gating.
  - [ ] SubTask 7.3: Document local/CI front-end testing workflow and required scenario coverage rules.

# Task Dependencies
- Task 2 depends on Task 1.
- Task 3 depends on Task 1.
- Task 4 depends on Task 1 and Task 3.
- Task 5 depends on Task 1 and Task 3.
- Task 6 depends on Task 1 and Task 4.
- Task 7 depends on Task 2, Task 3, Task 4, Task 5, and Task 6.
