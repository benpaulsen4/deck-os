# DeckOS

DeckOS is a self-hosted control panel for Linux homelab servers. It gives you a browser-based dashboard for system health, Docker Compose app management, host file access, and routine server administration without living in SSH all day.

## What DeckOS Does

- Shows live CPU, memory, disk, network, uptime, and Docker status
- Lets you deploy apps from templates or your own `docker-compose.yml`
- Gives you quick app controls for start, stop, restart, pull, logs, and metadata
- Includes a host file browser with upload, download, rename, copy, move, delete, and text editing
- Supports in-app update checks, one-click upgrades, and manual rollback
- Offers an optional local passcode lock for shared or semi-public spaces

## Who It Is For

DeckOS is built for people running a headless Linux server at home or in a private lab environment. It works best when you want a visual control surface for Docker-based services but still want direct access to the underlying compose files.

## Quick Start

### Requirements

- A Linux host with `systemd`
- Ubuntu `24.04`, `25.10`, or `26.04` for the provided installer
- Docker on the host, or permission for the installer to install it

### Install

DeckOS installs as a host-native service, not as a container. Releases are unpacked under `/opt/deckos` and managed through `systemd`.
The install script targets `benpaulsen4/deck-os` by default, so a normal install does not need repository arguments.
You only need to pass `--owner` or `--repo` if you are installing from a different fork or release source.

Preferred install command:

```bash
curl -fsSL https://script.benpaulsen.tech/install-deckos | sudo bash
```

Optional flags:

- `--owner <github-owner>`
- `--repo <github-repo>`
- `--token-file <path>`
- `--token-stdin`
- `--version 0.1.0`
- `--port 80`
- `--data-dir /var/lib/deckos`
- `--install-root /opt/deckos`
- `--service-name deckos`
- `--api-base https://api.github.com`

Pass optional flags through the hosted installer with `bash -s --`, for example:

```bash
curl -fsSL https://script.benpaulsen.tech/install-deckos | sudo bash -s -- --port 8080
```

Open DeckOS at `http://<host>/`.

One DeckOS instance is supported per host. `--service-name` renames the systemd unit only; the configuration directory, the service account and the helper scripts are shared, so a second install overwrites the first.

Re-running the installer is safe: values you do not pass again are read back out of the existing `/etc/deckos/deckos.env` rather than reset to defaults.

### Release Verification

Releases ship a `SHA256SUMS` manifest and a detached `ed25519` signature (`SHA256SUMS.sig`). The installer verifies the signature and then the archive digest before unpacking, and there is no flag to skip it. An unsigned or unverifiable release is refused.

### GitHub Token Note

DeckOS uses anonymous-first release checks and downloads. Supply a token only if the release source you are using requires authentication.

Prefer `--token-file <path>`, or `DECKOS_GITHUB_TOKEN` in the environment. A token passed as `--token <value>` is visible in `ps` to every local user for the duration of the install, and is recorded in your shell history.

## Documentation

The user guide lives in `docs/`:

- [Docs Home](docs/index.md)
- [Install DeckOS](docs/install.md)
- [Configure DeckOS](docs/configuration.md)
- [Get Started](docs/getting-started.md)
- [Manage Apps](docs/apps.md)
- [Use the Files Browser](docs/files.md)
- [Update, Roll Back, and Uninstall](docs/updates.md)
- [Security Notes](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security

DeckOS needs access to the host Docker daemon. In practice, that means it has powerful control over the machine it runs on.

Run it only on systems you trust, and avoid exposing it directly to the public internet without additional network and access controls.

## For Contributors

If you are working on DeckOS itself:

- Node.js `24+`
- pnpm `9.15.4`, pinned by `packageManager`; `engines` currently requires the 9.x line
- Docker if you want to exercise Docker-backed features locally

Dependency overrides are declared in both `package.json` (`pnpm.overrides`, read by pnpm 9) and `pnpm-workspace.yaml` (`overrides`, read by pnpm 10+). Keep the two in sync: if they drift, an install on the other generation silently drops the pins and reintroduces the advisories they suppress.

Common commands:

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

The development stack starts a Vite frontend on `http://localhost:5173` and a backend on `http://localhost:3001`.
The user guide lives under `docs/`, so keep README changes focused on first-time users and high-level contributor onboarding.
