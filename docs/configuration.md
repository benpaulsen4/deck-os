# Configure DeckOS

DeckOS reads its runtime configuration from `/etc/deckos/deckos.env`. Most people will only touch this file a few times: after installation, when changing ports or storage locations, and when using an authenticated GitHub release source. This page explains what the important settings do and when you should care about them.

## Common Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode |
| `PORT` | `3000` | Web UI and API listen port |
| `DECKOS_DATA_DIR` | `/var/lib/deckos` | Base directory for persistent DeckOS data |
| `DECKOS_INSTALL_ROOT` | `/opt/deckos` | Release installation root |
| `DECKOS_GITHUB_OWNER` | `benpaulsen4` | GitHub owner or organization for updates |
| `DECKOS_GITHUB_REPO` | `console-three` | GitHub repository name for updates |
| `DECKOS_GITHUB_TOKEN` | none | Optional token for private releases |
| `DECKOS_GITHUB_API_BASE` | `https://api.github.com` | GitHub API base URL |

## Data Directory

DeckOS stores managed apps under:

```text
<data-dir>/apps/<app-id>/
```

Each app directory contains:

- `docker-compose.yml`
- `metadata.json`

Other DeckOS data, such as security configuration, also lives under the data directory.

## Update Configuration

1. Leave `DECKOS_GITHUB_OWNER` and `DECKOS_GITHUB_REPO` alone if you are using the default DeckOS release source. The installer writes `benpaulsen4` and `console-three` automatically.
2. Set `DECKOS_GITHUB_TOKEN` only if your chosen release source requires authentication. Public releases do not require it.
3. Restart the service after changing update-related values so DeckOS picks up the new configuration cleanly.

## Port Changes

If you change `PORT`, restart the service:

```bash
sudo systemctl restart deckos
```

Then open DeckOS on the new port. Make sure any firewall or reverse proxy rules are updated at the same time.

## Service Name And Custom Install Paths

If you installed DeckOS with custom values such as `--service-name`, `--install-root`, or `--data-dir`, keep those values in mind for future maintenance. Rollback, troubleshooting, and uninstall steps are easier when you know exactly which paths the installer used. If you standardize those values early, future maintenance is much simpler.

## Optional Passcode Lock

DeckOS can run without a passcode, but you can enable one from `Settings`. When enabled, the app asks for a passcode before protected pages and actions, and that passcode can be set to any `4` to `10` digit value. Session duration is configurable between `1 hour` and `7 days`, and the feature is intended for trusted-network protection rather than as a full internet-facing identity system.
