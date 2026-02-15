# DeckOS

A self-hosted homelab management platform. DeckOS provides a unified dashboard and Docker Compose application manager for headless home servers.

## Quick Start

### Prerequisites

- Linux host (systemd-based recommended)
- Node.js 20 or higher
- Docker 20.10 or higher
- Docker Compose v2 (the `docker compose` CLI)

### Installation

DeckOS is intended to be installed as a host-native service (not a container). The production release mechanism is designed around prebuilt tarball releases plus a `systemd` unit.

**Planned host install layout:**

- `/opt/deckos/releases/<version>/` (immutable release directories)
- `/opt/deckos/current` (symlink to active release)
- `/etc/deckos/deckos.env` (configuration)
- `/var/lib/deckos/` (persistent data)

**Planned install flow (manual outline):**

1. Create a dedicated user (e.g. `deckos`) and grant Docker socket access (typically by adding to the `docker` group).
2. Download and extract the latest release tarball into `/opt/deckos/releases/<version>/`.
3. Create `/opt/deckos/current` symlink to that version.
4. Create `/etc/deckos/deckos.env` and set the data directory (default: `/var/lib/deckos`) and listen port (default: `3000`).
5. Install and enable the `systemd` service, then start it.

Access the dashboard at `http://<host>:3000`.

## Configuration

### Environment Variables

| Variable          | Default           | Description                                 |
| ----------------- | ----------------- | ------------------------------------------- |
| `NODE_ENV`        | `production`      | Environment mode                            |
| `DECKOS_DATA_DIR` | `/var/lib/deckos` | Persistent data directory for apps/metadata |
| `PORT`            | `3000`            | HTTP listen port                            |

## Updating DeckOS

Updates are planned to be atomic and to preserve the data directory across upgrades. The intended approach is:

1. Download and extract the new release into `/opt/deckos/releases/<new-version>/`
2. Switch `/opt/deckos/current` symlink to the new version
3. Restart the `deckos` service
4. Keep the previous release directory for rollback (flip symlink back and restart)

## Security Considerations

⚠️ **IMPORTANT:** DeckOS requires access to the Docker socket, which grants root-equivalent access to the host system. Only run DeckOS in trusted environments (e.g., your local network) and ensure it is not exposed to the public internet without proper authentication and access controls.

## Development

### Prerequisites

- Node.js 20 or higher
- pnpm 9 or higher
- Docker (optional - for Docker features)

### Windows Docker Desktop Setup

For Docker features to work in dev mode with Docker Desktop on Windows:

1. Install Docker Desktop
2. Ensure Docker Desktop is running

If you run the server in an environment that can’t access the Windows Docker named pipe (e.g. inside WSL), configure Docker connectivity via `DOCKER_HOST`.

### Setup

1. Install dependencies:

```bash
pnpm install
```

2. Start development servers:

```bash
pnpm dev
```

This starts:

- Frontend Vite dev server on `http://localhost:5173`
- Backend Hono server on `http://localhost:3001`

Docker features will be disabled if Docker Desktop is not accessible, but the app will still function for other features.

3. Type checking:

```bash
pnpm typecheck
```

### Building for Production

```bash
pnpm build
```

This builds both the client and server, outputting to:

- `packages/client/dist/` - Built React SPA
- `packages/server/dist/` - Compiled TypeScript

Production releases are planned to be packaged by CI into a tarball that includes the build outputs plus production dependencies, so end users don’t need to run `pnpm build` on the server.

## Usage

### Creating an App

1. Go to the Apps page and click "+ NEW APP"
2. Fill in the app metadata (name, description, icon URL)
3. Paste your `docker-compose.yml` in the editor
4. Click "VALIDATE" to check your YAML
5. Click "CREATE & DEPLOY" to start the stack

### Managing Apps

From the dashboard or Apps page, you can:

- Start/stop/restart compose stacks
- Pull latest images
- View container logs in real-time
- Edit the compose file
- Delete the app

## Architecture

- **Frontend**: React 19 + Vite 6 (SPA)
- **Backend**: Hono (Node.js 20)
- **API**: tRPC for type-safe client-server communication
- **State**: Zustand
- **Routing**: TanStack Router
- **Docker**: dockerode + Docker Compose CLI

### Data Storage

Apps are stored as:

```
<dataDir>/apps/<app-id>/
├── docker-compose.yml
└── metadata.json
```

No database is used - all data is file-based for simplicity and transparency.

## Troubleshooting

### DeckOS service won't start

Check service logs:

```bash
journalctl -u deckos -f
```

### Accessing the Docker socket

DeckOS requires access to the host Docker socket via `/var/run/docker.sock`. In the planned host-native deployment, the DeckOS service runs as a dedicated user that is granted Docker access (commonly via the `docker` group).

### Resetting DeckOS

To remove all DeckOS data (including managed app metadata/compose files), stop the service and remove the data directory:

```bash
systemctl stop deckos
rm -rf /var/lib/deckos
```

## License

MIT
