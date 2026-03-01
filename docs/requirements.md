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

### R4: App Templates System

- **R4.1** Provide a curated, offline-first library of pre-built app templates (metadata + compose template)
- **R4.2** From the Apps list page, users can open the Templates storefront via a button next to "+ NEW APP"
- **R4.3** Templates storefront supports search, pagination, and category filtering
- **R4.4** Each template listing displays: icon, title, short description/tagline, and category tags
- **R4.5** Selecting a template opens a detail view with full description and deployment actions
- **R4.6** Templates include user-fillable parameters (e.g., ports, environment values, volume host paths) with a streamlined form UI
- **R4.7** Volume host path parameters default to locations inside the app's data folder (e.g., relative paths under `<dataDir>/apps/<app-id>/`)
- **R4.8** Users can override any parameter before deployment; validation errors are surfaced inline (required values, invalid ports, invalid paths)
- **R4.9** Users can optionally edit the generated `docker-compose.yml` prior to deployment via the standard compose editor UI
- **R4.10** Deploying a template creates a normal managed app (compose saved to disk + metadata saved separately) and optionally starts the stack immediately
- **R4.11** Initial templates library is sourced from the CasaOS App Store repository (local path: `D:/CasaOS-AppStore`) and converted into DeckOS-compatible templates
- **R4.12** Converted templates must not rely on CasaOS-specific runtime variables (e.g., `$AppID`, `$PUID`, `$PGID`, `$TZ`); required values are represented as template parameters instead

### R5: System

- **R5.1** The platform runs directly on the host OS (no containerization) as a long-running service
- **R5.2** Persistent data (app configs, compose files, metadata) stored on disk in a configurable data directory (default: `/var/lib/deckos`)
- **R5.3** No authentication required at this stage (single-user, LAN-only assumption)
- **R5.4** The backend communicates with the host Docker daemon via the Docker socket (`/var/run/docker.sock`)
- **R5.5** All API communication between frontend and backend uses tRPC for end-to-end type safety
- **R5.6** Production installs support an idempotent host-native install flow and an update flow that preserves the data directory across upgrades (using GitHub Releases; private repo access via credentials is supported temporarily)

## Non-Requirements (Explicitly Out of Scope)

- User authentication and multi-user support
- Remote/WAN access management
- Online template marketplace or remote template registries
- Reverse proxy configuration
- Automated backups
- Plugin/extension system
- Mobile-native application

## Success Criteria

The platform is successful when a user can:

1. Open the DeckOS dashboard and immediately see their server's health
2. Paste a docker-compose.yml for any app (e.g., Jellyfin), deploy it, and see it appear as a launchable tile
3. Click the tile to open the app's web UI
4. Deploy a common app from a template, fill required parameters, and start it without writing YAML
5. View logs, restart, or tear down the stack -- all without touching a terminal
