# DeckOS - Architecture

## High-Level Overview

```
+--------------------------------------------------+
|                   Browser (SPA)                   |
|           React + Vite + tRPC Client              |
+--------------------------------------------------+
                        |
                   HTTP / WSS
                        |
+--------------------------------------------------+
|                  Hono HTTP Server                 |
|         tRPC Router + SSE/WS endpoints            |
+--------------------------------------------------+
            |                       |
     +------+------+        +------+------+
     |  Docker SDK |        |  System     |
     | (dockerode) |        |  Metrics    |
     +------+------+        | (systeminformation) |
            |                +-------------+
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
│   │   │   ├── App.tsx
│   │   │   ├── router.tsx          # TanStack Router
│   │   │   ├── trpc.ts             # tRPC client setup
│   │   │   ├── components/         # Shared UI components
│   │   │   │   ├── ui/             # Primitive components
│   │   │   │   └── layout/         # Shell, sidebar, etc.
│   │   │   ├── pages/              # Route pages
│   │   │   │   ├── Dashboard.tsx
│   │   │   │   ├── Apps.tsx
│   │   │   │   ├── AppDetail.tsx
│   │   │   │   ├── AppEditor.tsx
│   │   │   │   └── Settings.tsx
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
│       │   ├── index.ts            # Hono app entry + server start
│       │   ├── trpc/
│       │   │   ├── router.ts       # Root tRPC router
│       │   │   ├── context.ts      # tRPC context factory
│       │   │   └── trpc.ts         # tRPC init + middleware
│       │   ├── routers/
│       │   │   ├── system.ts       # System metrics procedures
│       │   │   ├── apps.ts         # App CRUD procedures
│       │   │   ├── docker.ts       # Docker operations procedures
│       │   │   └── logs.ts         # Log streaming procedures
│       │   ├── services/
│       │   │   ├── docker.ts       # Docker client wrapper
│       │   │   ├── compose.ts      # Compose file management
│       │   │   ├── metrics.ts      # System metrics collection
│       │   │   └── apps.ts         # App metadata persistence
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
| Styling        | Vanilla CSS + CSS Modules          | No framework overhead, full control for the brutalist aesthetic                                |
| Code Editor    | CodeMirror 6                       | YAML editing with syntax highlighting for compose files                                        |
| Runtime        | Node.js 20 LTS                     | Stable, wide compatibility                                                                     |
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

### AD5: tRPC for All Mutations and Queries

All CRUD operations (create app, list apps, update metadata, delete app) and Docker operations (start, stop, restart, pull, logs) go through tRPC procedures. This gives:

- Full type inference from backend to frontend
- Input validation via Zod at the procedure level
- Automatic error serialization
- TanStack Query integration for caching and optimistic updates

### AD6: Container Log Streaming

Container logs are streamed to the client via a dedicated SSE endpoint (one per container). The backend uses `dockerode`'s `container.logs({ follow: true, tail: 100 })` stream and pipes lines to the SSE response. The client renders logs in a virtual-scrolling terminal-style component.

## API Surface

### tRPC Procedures

```
system.getInfo        -> { hostname, os, uptime, dockerVersion }
system.getMetrics     -> { cpu, memory, disk, network } (one-shot)

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
```

### SSE Endpoints (direct Hono routes)

```
GET /api/metrics/stream       -> SSE: system metrics every 2s
GET /api/logs/:containerId    -> SSE: container log stream
GET /api/docker/events        -> SSE: Docker daemon events (container start/stop/die)
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

## Deployment Architecture

DeckOS runs directly on the host OS as a long-running service (no containerization). In production, the Hono server serves the built SPA static files and the API from the same port (default: 3000).

## Production Build & Release (Host-native)

### Release Artifact

DeckOS is released as a prebuilt, OS/arch-specific tarball produced by CI (users should not need a compiler toolchain on their server).

**Artifact contents (conceptual):**

- `server/` - compiled backend JS (`dist/`) plus production-only dependencies
- `client/` - built SPA static assets (`dist/`)
- `VERSION` / `manifest.json` - version + checksums/metadata for troubleshooting

### Host Install Layout

The production install separates immutable binaries from mutable data:

- `/opt/deckos/releases/<version>/` - immutable versioned release directories
- `/opt/deckos/current` - symlink to the active release
- `/etc/deckos/deckos.env` - environment/config file (owned by root)
- `/var/lib/deckos/` - persistent data directory (apps/, metadata/, etc.)

### Service Management

DeckOS is managed by `systemd` on Linux. The service runs as a dedicated user and is granted access to Docker via the `docker` group (or equivalent), so it can talk to `/var/run/docker.sock`.

**Planned service characteristics:**

- `User=deckos` with `SupplementaryGroups=docker`
- `EnvironmentFile=/etc/deckos/deckos.env`
- `WorkingDirectory=/opt/deckos/current`
- `Restart=on-failure`

### Updates and Rollback

Updates are designed to be atomic and data-safe:

1. Download the new release tarball and verify checksum/signature (when provided).
2. Extract to `/opt/deckos/releases/<new-version>/` without touching `/var/lib/deckos/`.
3. Stop the service, switch `/opt/deckos/current` symlink to the new version, start the service.
4. Keep at least one previous release directory for instant rollback (flip symlink back and restart).

## Security Considerations

- Access to the Docker socket (`/var/run/docker.sock`) gives root-equivalent access to the host. This is inherent to the product's purpose and matches CasaOS behavior.
- No authentication at this stage -- the assumption is LAN-only access behind a firewall.
- Compose YAML is validated but user-supplied; malicious YAML could mount host paths. This is acceptable for the single-user homelab context.
