# DeckOS - Requirements

## Product Purpose

DeckOS is a self-hosted homelab management platform that replaces CasaOS and similar tools. It provides a unified dashboard and Docker Compose application manager for headless home servers. The platform allows users to deploy, monitor, and manage containerized applications through a single web interface, eliminating the need for SSH access or CLI fluency for day-to-day homelab operations.

The name "DeckOS" evokes a command deck -- a control surface for the entire server.

## Target User

Homelab enthusiasts running headless Linux servers (Raspberry Pi, NUC, old laptops, rack servers) who want a visual interface to manage their Docker-based application stack. Users range from technical operators comfortable with compose files to those who prefer a GUI for routine tasks.

## Core Requirements

### R1: Dashboard

- **R1.1** Display real-time system resource usage: CPU %, memory usage/total, disk usage/total, network throughput (up/down)
- **R1.2** Resource metrics update via server-sent events or WebSocket at ~2 second intervals
- **R1.3** Show a quick-glance summary of running vs. stopped containers
- **R1.4** Display system hostname, OS, uptime, and Docker version

### R2: App Launcher

- **R2.1** Display installed apps as clickable tiles/icons on the dashboard
- **R2.2** Each app tile shows: app name, icon (URL or uploaded image), status indicator (running/stopped/error), and links to the app's web UI in a new tab
- **R2.3** Apps can be reordered or organized by the user
- **R2.4** Clicking an app tile opens the associated URL in a new browser tab
- **R2.5** An app's URL, name, icon, and description are user-configurable metadata stored separately from the compose file

### R3: Docker Compose Manager

- **R3.1** Users can create a new "app" by pasting or uploading a raw `docker-compose.yml` file
- **R3.2** The platform stores compose files on disk in a structured directory (`<dataDir>/apps/<app-id>/docker-compose.yml`)
- **R3.3** Users can start, stop, restart, and remove a compose stack from the UI
- **R3.4** Display per-app container status (running, stopped, restarting, error) in real-time
- **R3.5** Users can view and edit the raw compose YAML for any app
- **R3.6** Display container logs (stdout/stderr) for any container within a compose stack, with tail/follow capability
- **R3.7** Validate compose YAML syntax before deployment and surface errors to the user
- **R3.8** Support `docker compose pull` to update images for a stack
- **R3.9** Show per-container resource usage (CPU, memory) for running stacks

### R4: App Store / Templates (Stretch)

- **R4.1** Provide a curated library of pre-built compose templates (Jellyfin, Syncthing, Pi-hole, Nextcloud, etc.)
- **R4.2** Users can install a template which pre-fills the compose editor with sensible defaults
- **R4.3** Templates are defined as JSON/YAML files and can be extended by the user

### R5: System

- **R5.1** The platform runs directly on the host OS (no containerization) as a long-running service
- **R5.2** Persistent data (app configs, compose files, metadata) stored on disk in a configurable data directory (default: `/var/lib/deckos`)
- **R5.3** No authentication required at this stage (single-user, LAN-only assumption)
- **R5.4** The backend communicates with the host Docker daemon via the Docker socket (`/var/run/docker.sock`)
- **R5.5** All API communication between frontend and backend uses tRPC for end-to-end type safety
- **R5.6** Production installs support an idempotent host-native install flow and an update flow that preserves the data directory across upgrades

## Non-Requirements (Explicitly Out of Scope)

- User authentication and multi-user support
- Remote/WAN access management
- Reverse proxy configuration
- Automated backups
- Plugin/extension system
- Mobile-native application

## Success Criteria

The platform is successful when a user can:

1. Open the DeckOS dashboard and immediately see their server's health
2. Paste a docker-compose.yml for any app (e.g., Jellyfin), deploy it, and see it appear as a launchable tile
3. Click the tile to open the app's web UI
4. View logs, restart, or tear down the stack -- all without touching a terminal
