# DeckOS - Architecture

## High-Level Overview

```
+--------------------------------------------------+
|                   Browser (SPA)                   |
|           React + Vite + tRPC Client              |
+--------------------------------------------------+
                        |
                   HTTP / SSE
                        |
+--------------------------------------------------+
|                  Hono HTTP Server                 |
|         tRPC Router + HTTP/SSE endpoints          |
+--------------------------------------------------+
            |             |                 |
     +------+------+ +----+-----+    +------+------+
     |  Docker SDK | | Templates |    |  System     |
     | (dockerode) | | Library   |    |  Metrics    |
     +------+------+ +----+-----+    | (systeminformation) |
            |             |          +-------------+
     +------+------+
     | Docker      |
     | Daemon      |
     | (socket)    |
     +-------------+
```

DeckOS is a monorepo with two packages: a React SPA frontend and a Hono API backend, connected via tRPC for full end-to-end type safety. The backend communicates with the host Docker daemon through the Unix socket and collects system metrics via native OS APIs.

## Repository Structure

```
deckos/
├── package.json              # Root workspace config
├── tsconfig.base.json        # Shared TS config
├── packages/
│   ├── client/               # React SPA (Vite)
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── routeTree.gen.ts
│   │   │   ├── trpc.ts             # tRPC client setup
│   │   │   ├── components/         # Shared UI components
│   │   │   │   ├── ui/             # Primitive components
│   │   │   │   └── layout/         # Shell, sidebar, etc.
│   │   │   ├── routes/             # TanStack file-based routes
│   │   │   ├── hooks/              # Custom React hooks
│   │   │   ├── stores/             # Zustand stores
│   │   │   └── styles/             # Global CSS
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── server/               # Hono backend
│       ├── src/
│       │   ├── index.ts            # App assembly + server boot
│       │   ├── http/               # HTTP route registrars
│       │   │   ├── authRoutes.ts
│       │   │   ├── runtimeRoutes.ts
│       │   │   └── filesRoutes.ts
│       │   ├── trpc/
│       │   │   ├── router.ts       # Root tRPC router
│       │   │   ├── context.ts      # tRPC context factory
│       │   │   └── trpc.ts         # tRPC init + middleware
│       │   ├── routers/
│       │   │   ├── system.ts       # System metrics procedures
│       │   │   ├── apps.ts         # App CRUD procedures
│       │   │   ├── templates.ts    # Templates storefront + deploy procedures
│       │   │   ├── docker.ts       # Docker operations procedures
│       │   │   └── logs.ts         # Log streaming procedures
│       │   ├── services/
│       │   │   ├── docker.ts       # Docker client wrapper
│       │   │   ├── compose.ts      # Compose file management
│       │   │   ├── metrics.ts      # System metrics collection
│       │   │   └── apps.ts         # App metadata persistence
│       │   │   └── templates.ts    # Template loading + rendering + validation
│       │   ├── lib/
│       │   │   ├── schema.ts       # Zod schemas (shared types)
│       │   │   └── errors.ts       # Custom error types
│       │   └── data/               # Default data dir (overridable)
│       ├── tsconfig.json
│       └── package.json
```

## Technology Stack

| Layer          | Technology                         | Rationale                                                                                      |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Frontend       | React 19 + Vite 6                  | Required by spec. Fast HMR, ESM-native bundling                                                |
| Routing        | TanStack Router                    | Type-safe file routing, best-in-class for React SPAs                                           |
| State          | Zustand                            | Minimal, fast, no boilerplate state management                                                 |
| API Client     | tRPC + TanStack Query              | Required by spec. End-to-end type safety, automatic cache/refetch                              |
| Backend        | Hono                               | Required by spec. Lightweight, fast, middleware ecosystem                                      |
| API Layer      | tRPC via @hono/trpc-server         | Official Hono adapter for tRPC                                                                 |
| Docker         | dockerode                          | Mature Node.js Docker API client, supports all Docker operations                               |
| Compose Ops    | child_process (docker compose CLI) | Direct CLI invocation for compose up/down/pull -- more reliable than programmatic alternatives |
| System Metrics | systeminformation                  | Cross-platform system info library (CPU, mem, disk, network)                                   |
| Validation     | Zod                                | Runtime type validation, integrates natively with tRPC                                         |
| Styling        | Vanilla CSS + component styles     | No framework overhead, full control for the brutalist aesthetic                                |
| Code Editor    | CodeMirror 6                       | YAML editing with syntax highlighting for compose files                                        |
| Runtime        | Node.js 24 LTS                     | Stable, aligned with CI and release packaging                                                  |
| Package Mgr    | pnpm                               | Fast, disk-efficient, excellent workspace support                                              |

## Key Architecture Decisions

### AD1: Monorepo with pnpm Workspaces

The client and server live in a single repository under `packages/`. This enables:

- Shared TypeScript types (tRPC router type is imported directly by the client)
- Single `pnpm install` and coordinated dev scripts
- Unified production build + packaging

### AD2: Docker Compose via CLI, not programmatic API

Rather than using `dockerode-compose` (which has incomplete spec coverage), DeckOS invokes `docker compose` CLI commands via Node.js `child_process.execFile`. This guarantees:

- Full compose spec compatibility
- Identical behavior to manual CLI usage
- Reliable error output parsing

In production, the host must have Docker Engine and Docker Compose v2 installed so `docker compose` is available to the DeckOS service.

### AD3: File-based App Storage

Each managed app is stored as:

```
<dataDir>/apps/<app-id>/
├── docker-compose.yml    # The raw compose file
└── metadata.json         # Name, icon URL, web URL, description, order
```

This is deliberately simple -- no database. In production the default `<dataDir>` is `/var/lib/deckos` and is configurable (e.g. `DECKOS_DATA_DIR`). The `metadata.json` includes:

```json
{
  "id": "jellyfin-abc123",
  "name": "Jellyfin",
  "icon": "https://jellyfin.org/icon.png",
  "url": "http://192.168.1.50:8096",
  "description": "Media server",
  "order": 1,
  "createdAt": "2026-02-09T00:00:00Z",
  "updatedAt": "2026-02-09T00:00:00Z"
}
```

### AD4: Real-time Metrics via SSE

System metrics (CPU, memory, disk, network) are pushed to the client via Server-Sent Events (SSE) rather than WebSocket. Rationale:

- Simpler protocol (unidirectional, HTTP-native)
- Hono has built-in SSE support via `hono/streaming`
- Automatic reconnection built into the browser EventSource API
- Sufficient for our read-only metrics use case

The SSE endpoint sits outside tRPC (as a direct Hono route) since tRPC subscriptions add complexity with minimal benefit for this one-way stream.

### AD5: tRPC-First API with HTTP/SSE for Streaming and Transfer Paths

Most CRUD and orchestration operations go through tRPC procedures, while streaming/transfer paths use direct HTTP endpoints (SSE events/logs/metrics, upload/download/content, and pull job tracking). This gives:

- Full type inference from backend to frontend
- Input validation via Zod at the procedure level
- Automatic error serialization
- TanStack Query integration for caching and optimistic updates

### AD6: Container Log Streaming

Container logs are streamed to the client via a dedicated SSE endpoint (one per container). The backend uses `dockerode`'s `container.logs({ follow: true, tail: 100 })` stream and pipes lines to the SSE response. The client renders logs in a virtual-scrolling terminal-style component.

### AD7: Template Library is Bundled, Rendered Server-Side

Templates are shipped with the DeckOS server as an immutable library (read-only at runtime). A template is not installed directly; it is rendered into a standard DeckOS app (compose + metadata) at deploy time. Rationale:

- Offline-first storefront (no external registry required)
- Deterministic behavior: the exact compose file that will be deployed is shown to the user
- Security: server validates parameter values and ensures all placeholders are resolved before writing to disk

### AD8: File Browser Uses Whole-Host Access with Fixed Protected Path Denylist

The Files module targets full host filesystem browsing, but enforces a fixed denylist of protected system paths. Rationale:

- Matches the product goal of replacing CasaOS-style host file management
- Keeps behavior predictable for users by avoiding dynamic path-policy complexity in v0.2
- Reduces catastrophic risk by hard-blocking sensitive OS/runtime paths

All file operations must resolve and validate requested paths against the denylist before IO. Denied access returns explicit permission/protection errors.

### AD9: Files Metadata and Mutations via tRPC; Binary Content via Direct HTTP Routes

The Files module uses tRPC for metadata and mutating operations (list, stat, create, rename, copy, move, delete, write-text), and direct Hono routes for streaming file bytes (download, media preview, upload multipart). Rationale:

- Keeps DeckOS consistent with existing type-safe tRPC mutation/query patterns
- Preserves efficient binary streaming semantics (range requests, multipart bodies) outside JSON RPC
- Supports browser-native media playback without adding transcoding complexity in v0.2

## Templates

### Template Library Layout (Conceptual)

Templates are distributed as part of the server package (immutable) and are loaded from disk at runtime. Each template is a small directory containing a metadata file, a compose template, and optional static assets (icon/screenshots).

```
server/
└── templates/
    └── <template-id>/
        ├── template.json          # TemplateDetail metadata + parameters schema
        ├── docker-compose.yml     # Compose template with placeholders
        └── assets/                # Optional: icon.png, screenshots, etc.
```

### Template Schema (Conceptual)

Templates are defined as JSON files validated with Zod. Core fields:

- `id`: stable template identifier (used in URLs and API)
- `title`, `description`, `categories[]`, `icon` (URL or server-served asset path)
- `webUrlTemplate`: optional; supports placeholders (e.g. `http://{{DECKOS_HOST}}:{{WEB_PORT}}`)
- `composeTemplate`: the raw compose template contents (or loaded from `docker-compose.yml`)
- `parameters[]`: ordered list of user-fillable parameter definitions used to render placeholders

### Placeholder Rendering

Compose templates use a simple placeholder format to avoid Docker Compose environment interpolation:

- Placeholders: `{{PARAM_KEY}}`
- Rendering: server replaces placeholders with validated user values during `templates.deploy`
- Validation: deploy fails if any placeholder remains unresolved after rendering

Parameter types include (at minimum): `string`, `number`, `boolean`, `port`, `path`, and `enum`.

**Volume paths**

- Default template volume host paths are expressed as relative paths (e.g. `./config`, `./data`) so they resolve under `<dataDir>/apps/<app-id>/` when the stack is deployed.
- Users may override to absolute paths for advanced setups (e.g. `/mnt/media`).

### CasaOS App Store Source (Initial Library)

The initial DeckOS template library is sourced from the CasaOS App Store repository on disk (`D:/CasaOS-AppStore`). A conversion step is required to normalize CasaOS apps into DeckOS templates:

- Read `Apps/<AppName>/appfile.json` for metadata (title, description/overview, categories, default WebUI port)
- Read `Apps/<AppName>/docker-compose.yml` for the base compose
- Remove CasaOS-only extensions (`x-casaos`) and references to CasaOS runtime variables (e.g. `$AppID`)
- Convert CasaOS volume patterns like `/DATA/AppData/$AppID/...` to relative `./...` paths by default
- Convert advanced CasaOS concepts (ports/envs/devices) into template parameters when needed

## API Surface

### tRPC Procedures

```
system.getInfo        -> { hostname, os, uptime, dockerVersion }
system.getMetrics     -> { cpu, memory, disk, network } (one-shot)

templates.list        -> { items: TemplateSummary[], total: number, categories: string[] }
templates.get         -> TemplateDetail
templates.deploy      -> App         (input: templateId + parameter values + optional compose override)

apps.list             -> App[]
apps.get              -> App
apps.create           -> App         (input: compose YAML + metadata)
apps.update           -> App         (input: partial metadata)
apps.updateCompose    -> App         (input: new YAML string)
apps.delete           -> void
apps.reorder          -> void        (input: ordered ID list)

docker.start          -> void        (input: appId)
docker.stop           -> void        (input: appId)
docker.restart        -> void        (input: appId)
docker.pull           -> stream      (input: appId)
docker.getContainers  -> Container[] (input: appId)
docker.getStatus      -> StackStatus (input: appId)

files.list            -> { cwd, entries[] } (input: path, showHidden, viewMode, sort)
files.getMeta         -> FileMeta
files.readText        -> { content, encoding, truncated, readOnlySuggested }
files.writeText       -> void        (input: path, content)
files.mkdir           -> void
files.rename          -> void
files.copy            -> JobStatus | void
files.move            -> void        (rename, fallback copy+delete across filesystems)
files.delete          -> void
files.getPins         -> { items: string[] }
files.setPins         -> { items: string[] } (global pinned directories)
```

### SSE Endpoints (direct Hono routes)

```
GET /api/metrics/stream       -> SSE: system metrics every 2s
GET /api/logs/:containerId    -> SSE: container log stream
GET /api/docker/events        -> SSE: Docker daemon events (container start/stop/die)
GET /api/files/content        -> stream: file bytes (supports Range for media)
POST /api/files/upload        -> multipart upload to target directory
GET /api/files/download       -> attachment response for a single file
```

## Data Flow

### App Deployment Flow

```
User pastes YAML ──> Client validates syntax
                       │
                       ▼
               tRPC apps.create ──> Server validates YAML
                                      │
                                      ├── Write compose file to <dataDir>/apps/<id>/
                                      ├── Write metadata.json
                                      └── Return App object
                                            │
                                            ▼
                                 User clicks "Deploy"
                                            │
                                            ▼
                                 tRPC docker.start
                                      │
                                      ├── exec: docker compose -f <path> up -d
                                      ├── Monitor container status via dockerode
                                      └── Push status updates via Docker events SSE
```

### Template Deployment Flow

```
User selects template ──> tRPC templates.get
                                │
                                ├── Return TemplateDetail (metadata + parameters + compose template)
                                ▼
User fills parameter form ──> (optional) edit generated compose in UI
                                │
                                ▼
                        tRPC templates.deploy
                                │
                                ├── Validate parameter values (required, ports, paths)
                                ├── Render compose template -> final docker-compose.yml
                                ├── Derive/validate metadata (name/icon/url/description)
                                ├── Persist as normal app under <dataDir>/apps/<app-id>/
                                └── Optionally start stack (internally calls docker.start)
```

### Metrics Flow

```
systeminformation polls (2s interval)
       │
       ▼
  Format metrics object
       │
       ▼
  Push to all SSE subscribers on /api/metrics/stream
       │
       ▼
  Client Zustand store updates
       │
       ▼
  Dashboard components re-render
```

### File Browser Flow

```
User opens Files tab ──> tRPC files.list(path, showHidden)
                            │
                            ├── Validate path against fixed denylist
                            ├── Read directory entries + metadata
                            └── Return entries for table/icon view
                                  │
                                  ▼
User opens text file ──> tRPC files.readText
                            │
                            ├── Apply size threshold policy
                            ├── Return content + readOnlySuggested
                            └── Client opens full-page editor
                                  │
                                  ▼
                           tRPC files.writeText
                                  │
                                  └── Persist with last-save-wins behavior

User previews media ──> GET /api/files/content?path=...
                            │
                            ├── Validate path and denylist
                            ├── Return range-capable stream
                            └── Browser-native playback/rendering

User uploads file(s) ──> POST /api/files/upload (multipart)
                            │
                            ├── Validate destination path
                            ├── Stream file(s) to disk
                            └── Refresh directory listing via files.list
```

## Deployment Architecture

DeckOS runs directly on the host OS as a long-running service (no containerization). In production, the Hono server serves the built SPA static files and the API from the same port (default: 3000).

## Production Build & Release (Host-native)

### Release Artifact

DeckOS is released as a prebuilt, OS/arch-specific tarball produced by CI (users should not need a compiler toolchain on their server). CI publishes the tarball to GitHub Releases on version tags.

**Artifact contents (conceptual):**

- `packages/server/dist/` - compiled backend JS
- `packages/server/templates/` - bundled template library
- `packages/client/dist/` - built SPA static assets
- `node_modules/` - production-only dependencies
- `VERSION` - release version

### Host Install Layout

The production install separates immutable binaries from mutable data:

- `/opt/deckos/releases/<version>/` - immutable versioned release directories
- `/opt/deckos/current` - symlink to the active release
- `/etc/deckos/deckos.env` - environment/config file (owned by root)
- `/var/lib/deckos/` - persistent data directory (apps/, metadata/, etc.)

### Service Management

DeckOS is managed by `systemd` on Linux. The service runs as a dedicated user and is granted access to Docker via the `docker` group (or equivalent), so it can talk to `/var/run/docker.sock`.

**Service characteristics:**

- `User=deckos` with `SupplementaryGroups=docker`
- `EnvironmentFile=/etc/deckos/deckos.env`
- `WorkingDirectory=/opt/deckos/current`
- `Restart=always` (used to restart after self-update)
- Fatal runtime faults (`uncaughtException`/`unhandledRejection`) exit the process with a non-zero code so `systemd` can perform a clean supervised restart

### Updates and Rollback

Updates are designed to be atomic and data-safe:

1. Download the new release tarball and verify checksum/signature (when provided).
2. Extract to `/opt/deckos/releases/<new-version>/` without touching `/var/lib/deckos/`.
3. Switch `/opt/deckos/current` symlink to the new version and restart the `deckos` service (or exit cleanly under `Restart=always`).
4. Keep at least one previous release directory for instant rollback (flip symlink back and restart).

### Private Repo Access (Temporary)

While the GitHub repo is private, both install and update flows require GitHub credentials:

- `DECKOS_GITHUB_OWNER`, `DECKOS_GITHUB_REPO`
- `DECKOS_GITHUB_TOKEN` (a token with access to the private repo)

## Security Considerations

- Access to the Docker socket (`/var/run/docker.sock`) gives root-equivalent access to the host. This is inherent to the product's purpose and matches CasaOS behavior.
- No authentication at this stage -- the assumption is LAN-only access behind a firewall.
- Compose YAML is validated but user-supplied; malicious YAML could mount host paths. This is acceptable for the single-user homelab context.
- Templates are treated as user-supplied inputs at deploy time: rendered output is shown/editable before deploy, and server-side validation ensures all template placeholders are resolved and parameter types are enforced.
- Files module path access is constrained by a fixed protected-path denylist; all browse/read/write/upload/download operations must enforce it consistently.
- Path traversal prevention must use normalized absolute path resolution before filesystem access; symbolic link escapes must be denied when they resolve into protected paths.
- Direct file streaming endpoints must enforce explicit content disposition/content type behavior and return clear errors on denied/unreadable paths.
- Large text file reads should surface read-only guidance to the client to prevent browser instability.
