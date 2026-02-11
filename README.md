# DeckOS

A self-hosted homelab management platform. DeckOS provides a unified dashboard and Docker Compose application manager for headless home servers.

## Quick Start

### Prerequisites

- Docker 20.10 or higher
- Docker Compose v2
- Linux host with Docker installed

### Installation

1. Build and start DeckOS:
```bash
docker compose up -d
```

2. Access the dashboard at `http://localhost:3000`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Environment mode |

### Volume Mounts

- `/var/run/docker.sock` - Docker socket for container management
- `deckos-data:/data` - Persistent storage for app configs and compose files

## Security Considerations

⚠️ **IMPORTANT:** DeckOS requires access to the Docker socket, which grants root-equivalent access to the host system. Only run DeckOS in trusted environments (e.g., your local network) and ensure it is not exposed to the public internet without proper authentication and access controls.

## Development

### Prerequisites

- Node.js 20 or higher
- pnpm 9 or higher

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
/data/apps/<app-id>/
├── docker-compose.yml
└── metadata.json
```

No database is used - all data is file-based for simplicity and transparency.

## Troubleshooting

### Container won't start

Check the container logs:
```bash
docker logs deckos
```

### Accessing the Docker socket

DeckOS requires access to the host Docker socket via `/var/run/docker.sock`. Verify the volume mount in `docker-compose.yml`.

### Resetting DeckOS

To remove all DeckOS data (including deployed apps):
```bash
docker compose down -v
```

## License

MIT