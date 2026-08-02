# Configure DeckOS

DeckOS reads its runtime configuration from `/etc/deckos/deckos.env`. Most people will only touch this file a few times: after installation, when changing ports or storage locations, and when using an authenticated GitHub release source. This page explains what the important settings do and when you should care about them.

## Common Settings

| Variable                 | Default                  | Purpose                                   |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `NODE_ENV`               | `production`             | Runtime mode                              |
| `PORT`                   | `80`                     | Web UI and API listen port                |
| `DECKOS_DATA_DIR`        | `/var/lib/deckos`        | Base directory for persistent DeckOS data |
| `DECKOS_INSTALL_ROOT`    | `/opt/deckos`            | Release installation root                 |
| `DECKOS_GITHUB_OWNER`    | `benpaulsen4`            | GitHub owner or organization for updates  |
| `DECKOS_GITHUB_REPO`     | `deck-os`                | GitHub repository name for updates        |
| `DECKOS_GITHUB_TOKEN`    | none                     | Optional token for private releases       |
| `DECKOS_GITHUB_API_BASE` | `https://api.github.com` | GitHub API base URL                       |

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

1. Leave `DECKOS_GITHUB_OWNER` and `DECKOS_GITHUB_REPO` alone if you are using the default DeckOS release source. The installer writes `benpaulsen4` and `deck-os` automatically.
2. Set `DECKOS_GITHUB_TOKEN` only if your chosen release source requires authentication. Public releases do not require it.
3. Restart the service after changing update-related values so DeckOS picks up the new configuration cleanly.

## Port Changes

If you change `PORT`, restart the service:

```bash
sudo systemctl restart deckos
```

Then open DeckOS on the new port. Make sure any firewall or reverse proxy rules are updated at the same time.

## One Instance Per Host

DeckOS supports a single instance per host.

`--service-name` renames the `systemd` unit and nothing else. The configuration directory `/etc/deckos`, the `deckos` service account, `/usr/local/bin/deckos-node`, `/usr/local/bin/deckos-fix-cpu-power-perms`, and the `/etc/sudoers.d/deckos-power` rule are all shared, and the unit always reads `EnvironmentFile=/etc/deckos/deckos.env`.

So installing a second instance under a different service name overwrites the first instance's configuration, and uninstalling either one removes `/etc/deckos` and breaks the survivor. Use `--service-name` when you want the unit called something other than `deckos`, not to run two copies side by side.

## Service Name And Custom Install Paths

If you installed DeckOS with custom values such as `--service-name`, `--install-root`, or `--data-dir`, keep those values in mind for future maintenance. Rollback and troubleshooting are easier when you know exactly which paths the installer used.

You no longer need to retype them. Re-running the installer reads any value you do not pass again out of the existing `/etc/deckos/deckos.env`, and the uninstall script defaults its paths from the same file.

## Optional Passcode Lock

DeckOS can run without a passcode, but you can enable one from `Settings`. When enabled, the app asks for a passcode before protected pages and actions, and that passcode can be set to any `4` to `10` digit value. Session duration is configurable between `1 hour` and `7 days`, and the feature is intended for trusted-network protection rather than as a full internet-facing identity system.
