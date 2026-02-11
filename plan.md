# DeckOS - Build Plan

## Phase Overview

| Phase | Name                        | Depends On | Estimated Effort |
| ----- | --------------------------- | ---------- | ---------------- |
| 0     | Project Scaffolding         | -          | Small            |
| 1     | Backend Core                | 0          | Medium           |
| 2     | Frontend Shell & Dashboard  | 0, 1       | Medium           |
| 3     | Docker Compose Manager      | 1          | Large            |
| 4     | App Launcher & Detail Pages | 2, 3       | Medium           |
| 5     | Logs, Streaming & Polish    | 3, 4       | Medium           |
| 6     | Containerization & E2E      | All        | Small            |

---

## Phase 0: Project Scaffolding

**Goal**: Set up the monorepo structure, install all dependencies, configure tooling, and create placeholder files so that subsequent phases can begin coding immediately.

### Tasks

1. Initialize pnpm workspace root with `package.json` and `pnpm-workspace.yaml`
2. Create `packages/client/` -- Vite + React project with:
   - `vite.config.ts` with proxy to backend dev server
   - `tsconfig.json` extending base config
   - Entry point (`main.tsx`, `App.tsx`) with placeholder content
   - CSS variables file with the full design token palette from `design.md`
   - Google Fonts loaded (JetBrains Mono, Space Mono)
   - TanStack Router installed and configured with empty route stubs
   - tRPC client configured (pointing to `/api/trpc`)
   - Zustand installed
3. Create `packages/server/` -- Hono + tRPC project with:
   - `src/index.ts` Hono app with health check route
   - tRPC initialization (`trpc.ts`, `context.ts`, `router.ts`) with one example procedure
   - `@hono/trpc-server` middleware wired to `/api/trpc`
   - CORS middleware for dev
   - `tsx` for dev mode (watch + run)
   - Zod installed
4. Create `tsconfig.base.json` at root with shared compiler options
5. Root `package.json` dev script that runs client and server concurrently
6. `.gitignore` for Node.js/TypeScript projects
7. Verify: `pnpm install` succeeds, `pnpm dev` starts both client (port 5173) and server (port 3001), client can call the example tRPC procedure and display the result

### Acceptance Criteria

- [x] `pnpm install` completes with zero errors
- [x] `pnpm dev` starts both Vite dev server and Hono dev server
- [x] Navigating to `http://localhost:5173` shows the React app
- [x] The React app successfully calls a tRPC procedure (`system.ping`) and displays the response
- [x] CSS variables from the design system are loaded and applied
- [x] JetBrains Mono font renders correctly
- [x] TypeScript compilation is clean (`pnpm typecheck` passes)
- [x] TanStack Router is configured with stub routes for `/`, `/apps`, `/apps/:id`, `/apps/new`, `/settings`

---

## Phase 1: Backend Core

**Goal**: Implement all backend services, tRPC procedures, and SSE endpoints. The backend should be fully functional and testable independent of the frontend.

### Tasks

1. **System Metrics Service** (`services/metrics.ts`)
   - Use `systeminformation` package to collect CPU, memory, disk, and network stats
   - Create a polling loop (2s interval) that caches the latest metrics
   - Expose a one-shot `system.getMetrics` tRPC procedure
   - Expose a `system.getInfo` tRPC procedure (hostname, OS, uptime, Docker version)

2. **Metrics SSE Endpoint** (`/api/metrics/stream`)
   - Hono SSE route using `hono/streaming`
   - Pushes JSON metrics every 2 seconds to all connected clients
   - Handles client disconnection cleanly

3. **App Metadata Service** (`services/apps.ts`)
   - CRUD operations for app metadata (JSON files on disk)
   - Directory management: create/delete `/data/apps/<id>/` directories
   - Schema validation with Zod for app metadata

4. **App tRPC Router** (`routers/apps.ts`)
   - `apps.list`, `apps.get`, `apps.create`, `apps.update`, `apps.updateCompose`, `apps.delete`, `apps.reorder`
   - Input validation via Zod
   - Compose YAML validation (parse YAML, check for `services` key)

5. **Docker Service** (`services/docker.ts`)
   - Initialize dockerode client connected to `/var/run/docker.sock`
   - Functions: `startStack`, `stopStack`, `restartStack`, `pullStack`, `getStackContainers`, `getStackStatus`
   - All compose operations via `child_process.execFile('docker', ['compose', ...])`
   - Parse compose project name from app ID for container association

6. **Docker tRPC Router** (`routers/docker.ts`)
   - Procedures wrapping all docker service functions
   - Input: `appId` string, validated against existing apps

7. **Docker Events SSE** (`/api/docker/events`)
   - Stream Docker daemon events (container start/stop/die/create) via SSE
   - Use dockerode's `docker.getEvents()` stream

8. **Container Logs SSE** (`/api/logs/:containerId`)
   - Stream stdout/stderr from a specific container via SSE
   - Support `tail` query parameter (default 200 lines)
   - Use dockerode's `container.logs({ follow: true })` stream

9. **Shared Schemas** (`lib/schema.ts`)
   - Zod schemas for: App, AppMetadata, ComposeFile, SystemMetrics, SystemInfo, ContainerInfo, StackStatus

### Acceptance Criteria

- [x] `system.getInfo` returns valid system information
- [x] `system.getMetrics` returns CPU, memory, disk, and network data
- [x] `/api/metrics/stream` emits SSE events every ~2 seconds
- [x] `apps.create` writes a compose file and metadata to disk, returns the app object
- [x] `apps.list` returns all apps, `apps.get` returns a single app
- [x] `apps.updateCompose` validates YAML and rewrites the file
- [x] `apps.delete` removes the app directory
- [x] `docker.start` runs `docker compose up -d` for the app's compose file
- [x] `docker.stop` runs `docker compose down` for the app's compose file
- [x] `docker.getContainers` returns container info for a running stack
- [x] `/api/docker/events` streams container lifecycle events
- [x] `/api/logs/:containerId` streams container logs
- [x] Invalid compose YAML is rejected with a descriptive error
- [x] All procedures have Zod input validation

---

## Phase 2: Frontend Shell & Dashboard

**Goal**: Build the application shell (top bar, routing, layout) and the fully functional dashboard page with real-time metrics and the app launcher grid.

### Tasks

1. **Global Styles**
   - Implement all CSS variables from `design.md`
   - Reset/normalize styles
   - Base typography (JetBrains Mono everywhere, scale, spacing)
   - Utility classes for status colors

2. **Top Bar Component**
   - DECKOS logotype with accent color and letter-spacing
   - Navigation links: Dashboard, Apps, Settings
   - Active route highlighting (2px bottom border, accent color)
   - Hostname display on the right
   - Responsive: hamburger menu below 768px

3. **App Shell / Layout**
   - Top bar + scrollable content area
   - Max-width 1440px centered container
   - TanStack Router outlet for page content

4. **System Info Bar**
   - Full-width bar showing hostname, OS, uptime, Docker version, container counts
   - Data from `system.getInfo` tRPC query

5. **Metrics Cards**
   - 4-column grid (responsive to 2-col, 1-col)
   - Each card: label, large number, usage bar, sparkline
   - Subscribe to `/api/metrics/stream` SSE
   - Zustand store for metrics state with history buffer (60 points for sparklines)

6. **Sparkline Component**
   - SVG polyline rendered from the last 60 metric values
   - Stroke color per-metric, no fill, 1px stroke
   - Animates smoothly as new points arrive

7. **App Launcher Grid**
   - Grid of app tiles from `apps.list` tRPC query
   - Each tile: icon (with fallback), name, status dot + label
   - Clicking tile opens external URL in new tab
   - Gear icon on hover links to `/apps/:id`
   - Empty state: "NO APPS INSTALLED" message with link to `/apps/new`

8. **Loading & Error States**
   - Scanning line loading animation
   - Error boundary with styled error panel

### Acceptance Criteria

- [x] App loads with the DeckOS shell (top bar, correct fonts, dark theme)
- [x] Navigation between routes works (Dashboard, Apps, Settings stubs)
- [x] Dashboard shows system info bar with live data
- [x] Four metric cards display CPU, memory, disk, network with real-time updates
- [x] Sparklines render and animate with incoming data
- [x] Usage bars animate on value changes
- [x] App launcher grid shows installed apps with correct status
- [x] Clicking an app tile opens its URL in a new tab
- [x] Empty state displays correctly when no apps exist
- [x] Layout is responsive across breakpoints (1440+, 1024, 768, mobile)
- [x] All text uses JetBrains Mono / Space Mono fonts
- [x] Design matches the brutalist console aesthetic described in `design.md`

---

## Phase 3: Docker Compose Manager

**Goal**: Build the app creation flow, compose editor, and Docker operation controls. Users can paste a compose file, deploy it, and manage it.

### Tasks

1. **New App Page** (`/apps/new`)
   - Form: app name, description, icon URL, web URL
   - CodeMirror editor for compose YAML (dark theme, YAML mode)
   - Validate button (calls backend YAML validation)
   - Create & Deploy button (calls `apps.create` then `docker.start`)
   - Error display for validation failures

2. **CodeMirror Integration**
   - Install CodeMirror 6 with YAML language support
   - Custom theme matching DeckOS palette (dark bg, green strings, muted comments)
   - Line numbers in `--text-muted`
   - Active line highlighting

3. **App Detail Page** (`/apps/:id`)
   - App header: icon, name, description, status, external URL button
   - Action bar with Start, Stop, Restart, Pull Images, Delete buttons
   - Action buttons trigger tRPC mutations with optimistic UI updates
   - Confirmation dialog for destructive actions (Stop, Delete)

4. **Container Table**
   - Shows all containers in the compose stack
   - Columns: Name, Image, Status, CPU %, Memory, Ports
   - Auto-refreshes via Docker events SSE
   - Per-container mini resource bars

5. **Compose Editor Section**
   - CodeMirror showing current compose file (from `apps.get`)
   - Edit + Save flow (calls `apps.updateCompose`)
   - Requires stack restart banner when compose is modified

6. **Pull Progress**
   - When "Pull Images" is clicked, show a progress panel
   - Display pull output streamed from the backend

### Acceptance Criteria

- [x] User can navigate to `/apps/new` and see the creation form
- [x] CodeMirror editor renders with YAML syntax highlighting and DeckOS dark theme
- [x] Pasting valid compose YAML and clicking "Create & Deploy" creates the app and starts the stack
- [x] Invalid YAML shows an error message
- [x] App detail page shows correct app information and container status
- [x] Start/Stop/Restart buttons trigger compose operations and UI updates
- [x] Container table shows all containers with accurate status
- [x] Compose editor allows editing and saving the compose file
- [x] Delete button removes the app (with confirmation)
- [x] Pull operation shows progress feedback

---

## Phase 4: App Launcher & Detail Polish

**Goal**: Complete the Apps list page, implement app reordering, refine the detail page with per-container resources, and connect the dashboard launcher to live Docker status.

### Tasks

1. **Apps List Page** (`/apps`)
   - Table/list view with columns: Name, Status, Containers, Created, Actions
   - Action buttons per row: Start, Stop, Restart, Delete
   - Link to detail page on name click
   - "New App" button linking to `/apps/new`

2. **App Reordering**
   - Drag-and-drop reordering of app tiles on the dashboard launcher
   - Persists order via `apps.reorder` tRPC mutation
   - Use a lightweight DnD library (e.g., `@dnd-kit/core`)

3. **Live Status Integration**
   - Subscribe to Docker events SSE on the dashboard
   - Update app tile status indicators in real-time when containers start/stop
   - Flash animation on status change

4. **Per-Container Resources on Detail Page**
   - CPU and memory bars for each container in the container table
   - Polling container stats via dockerode at ~5s interval

5. **Settings Page** (`/settings`)
   - Display system info (read-only)
   - Data directory path
   - About / version info

### Acceptance Criteria

- [x] Apps list page shows all apps in a tabular format
- [x] Row actions (Start, Stop, Restart, Delete) work correctly
- [x] Dashboard app tiles update status in real-time via Docker events
- [x] App tile reordering works via drag-and-drop and persists
- [x] Container table on detail page shows CPU/memory bars
- [x] Settings page displays system information
- [x] Status change animations fire correctly

---

## Phase 5: Logs, Streaming & Polish

**Goal**: Implement the container log viewer, finalize all streaming functionality, and polish the UI to match the design spec.

### Tasks

1. **Container Log Viewer**
   - Tabbed interface (one tab per container in a stack)
   - Terminal-style rendering (monospace, dark background)
   - Connect to `/api/logs/:containerId` SSE endpoint
   - Auto-scroll with "follow" toggle
   - Timestamp column in muted color
   - Handle large log volumes with virtual scrolling

2. **Streaming Reliability**
   - SSE reconnection handling for metrics, Docker events, and logs
   - Connection status indicator in the UI (subtle, in the top bar)
   - Graceful degradation when backend is unreachable

3. **UI Polish**
   - Scanline effect on DECKOS logotype (CSS animation, 1s on load)
   - Status indicator pulse animation for running status
   - Scanning line loading animation implementation
   - Consistent hover states across all interactive elements
   - Review and refine spacing, typography, and color usage against `design.md`

4. **Error Handling**
   - Global error boundary
   - tRPC error formatting and display
   - Network error recovery UX
   - Toast/notification system for action feedback (app started, stopped, error, etc.)

5. **Responsive Final Pass**
   - Test and fix all breakpoints
   - Mobile navigation (hamburger menu)
   - Touch-friendly tap targets

### Acceptance Criteria

- [x] Log viewer displays container logs in real-time
- [x] Logs auto-scroll and "follow" toggle works
- [x] Tab switching between containers works
- [x] SSE connections auto-reconnect on drop
- [x] Loading states use the scanning line animation
- [x] Running status indicators pulse subtly
- [x] DECKOS logotype has scanline effect on load
- [x] Errors are displayed in styled error panels
- [x] Toast notifications appear for user actions
- [x] UI is fully responsive and usable at all breakpoints
- [x] Full visual audit against `design.md` passes

---

## Phase 6: Containerization & End-to-End

**Goal**: Package DeckOS as a Docker image, write the self-hosting compose file, and verify the complete workflow end-to-end.

### Tasks

1. **Dockerfile**
   - Multi-stage build: dependencies -> build client -> build server -> runtime
   - Runtime stage: Node.js 20 slim + Docker CLI (no daemon)
   - Copy built client assets to be served by Hono
   - Configure Hono to serve static files from the client build directory

2. **Production Hono Configuration**
   - Serve Vite build output as static files
   - SPA fallback (all non-API routes return `index.html`)
   - Remove CORS middleware in production

3. **docker-compose.yml** (for DeckOS itself)
   - Single service: deckos
   - Port mapping: 3000:3000
   - Volume mounts: Docker socket + data volume
   - Restart policy: `unless-stopped`

4. **End-to-End Verification**
   - Build the Docker image
   - Run via docker-compose
   - Create an app (e.g., nginx), deploy it, verify it runs
   - Verify dashboard metrics work inside the container
   - Verify logs streaming works
   - Test stop/restart/delete lifecycle

5. **README.md**
   - Quick start instructions
   - Configuration options
   - Development setup

### Acceptance Criteria

- [x] `docker compose up` starts DeckOS on port 3000
- [x] Dashboard loads and displays system metrics
- [x] Can create, deploy, and manage a compose app through the UI
- [x] Container logs stream correctly
- [x] Data persists across container restarts (volume mount)
- [x] Image size is reasonable (< 500MB)
- [x] README provides clear setup instructions

---
