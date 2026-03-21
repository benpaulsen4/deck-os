# DeckOS

A self-hosted homelab management platform. DeckOS provides a unified dashboard and Docker Compose application manager for headless home servers.

## Quick Start

### Prerequisites

- Linux host (systemd-based; Ubuntu 24.04 and 25.10 supported by the installer)
- GitHub credentials for the private repo (temporary, until the repo is public)

### Installation

DeckOS is installed as a host-native service (not a container). Releases are published as prebuilt tarballs on GitHub Releases and installed under `/opt/deckos` with a `systemd` unit.

**Host install layout:**

- `/opt/deckos/releases/<version>/` (immutable release directories)
- `/opt/deckos/current` (symlink to active release)
- `/etc/deckos/deckos.env` (configuration)
- `/var/lib/deckos/` (persistent data)

**Install script (Ubuntu 24.04 / 25.10):**

From this repo root:

```bash
sudo ./install.sh --owner <github-owner> --repo <github-repo> --token <github-token>
```

Optional flags:

- `--version 0.1.0` (default: latest)
- `--port 3000`
- `--data-dir /var/lib/deckos`
- `--install-root /opt/deckos`

Access the dashboard at `http://<host>:3000`.

The installer uses NVM to install Node.js 24 for the `deckos` user and runs the service through a small wrapper at `/usr/local/bin/deckos-node`, so it won’t conflict with any system Node version.

## Configuration

### Environment Variables

| Variable                 | Default                  | Description                                                 |
| ------------------------ | ------------------------ | ----------------------------------------------------------- |
| `NODE_ENV`               | `production`             | Environment mode                                            |
| `DECKOS_DATA_DIR`        | `/var/lib/deckos`        | Persistent base data directory (apps are stored in `apps/`) |
| `PORT`                   | `3000`                   | HTTP listen port                                            |
| `DECKOS_INSTALL_ROOT`    | `/opt/deckos`            | Install root used for self-updates                          |
| `DECKOS_GITHUB_OWNER`    | (none)                   | GitHub owner/org for release checks/updates                 |
| `DECKOS_GITHUB_REPO`     | (none)                   | GitHub repo name for release checks/updates                 |
| `DECKOS_GITHUB_TOKEN`    | (none)                   | GitHub token for private repo access                        |
| `DECKOS_GITHUB_API_BASE` | `https://api.github.com` | GitHub API base (enterprise support)                        |

## Updating DeckOS

Updates are atomic and preserve the data directory across upgrades.

### In-app updates

- DeckOS periodically checks GitHub Releases (requires the GitHub env vars above).
- If a newer version is available, an `UPDATE` indicator appears in the top bar and details appear on the Settings page.
- Clicking `UPDATE NOW` downloads and extracts the new release into `/opt/deckos/releases/<version>/`, flips `/opt/deckos/current`, and restarts the service.

### Rollback

Flip the symlink back to a previous release directory and restart the service:

```bash
sudo ln -sfn /opt/deckos/releases/<old-version> /opt/deckos/current
sudo systemctl restart deckos
```

## Uninstall

Removes DeckOS (service, config, install dir, and data dir) but leaves Node.js and Docker installed:

```bash
sudo ./uninstall.sh
```

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

Production releases are packaged by CI into a tarball that includes the build outputs plus production dependencies, so end users don’t need to run `pnpm build` on the server.

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

### Crash and restart behavior

DeckOS is designed for supervised operation under `systemd` with `Restart=always`.
If the server hits an unrecoverable runtime fault (`uncaughtException` or `unhandledRejection`), it exits with a non-zero code so `systemd` can restart it cleanly.

For incident review:

```bash
journalctl -u deckos -n 200 --no-pager
```

### Accessing the Docker socket

DeckOS requires access to the host Docker socket via `/var/run/docker.sock`. The `deckos` service runs as a dedicated user that is granted Docker access (commonly via the `docker` group).

### CPU power metric shows N/A

DeckOS reads CPU power from Linux sysfs paths under `/sys/class/powercap` and `/sys/class/hwmon`. Some kernels expose these files as root-only by default. The service now runs a root pre-start step to grant group-read access on supported power sensor files before starting as the non-root `deckos` user.

If CPU power still shows `N/A`, restart the service and check logs for permission warnings:

```bash
sudo systemctl restart deckos
journalctl -u deckos -n 200 --no-pager | grep "CPU power metric"
```

### Resetting DeckOS

To remove all DeckOS data (including managed app metadata/compose files), stop the service and remove the data directory:

```bash
systemctl stop deckos
rm -rf /var/lib/deckos
```

## License

MIT
