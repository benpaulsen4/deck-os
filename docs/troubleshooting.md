# Troubleshooting

This page covers the most common operational issues. Most problems in DeckOS fall into a few predictable categories: the service is not running, Docker is unavailable, a compose stack is invalid, or the host permissions do not allow the requested action. The sections below are written to help you narrow down the failure quickly and then move to the right log or configuration source.

## DeckOS Will Not Start

Check the live service logs:

```bash
journalctl -u deckos -f
```

For recent logs without follow mode:

```bash
journalctl -u deckos -n 200 --no-pager
```

## The Web UI Does Not Load

Check:

- whether the service is running
- whether the configured port is open
- whether you are using the correct host and port

Useful commands:

```bash
sudo systemctl status deckos --no-pager
sudo ss -ltnp | grep 3000
```

Adjust the port in the second command if you changed `PORT`.

## Docker Is Not Accessible

DeckOS expects Docker access on the host. If Docker commands fail inside DeckOS:

- confirm Docker is installed
- confirm the Docker service is running
- confirm the `deckos` user has Docker access

Useful commands:

```bash
sudo systemctl status docker --no-pager
getent group docker
```

## CPU Power Metric Shows `N/A`

Some Linux systems expose power sensor files with restrictive permissions.

Try restarting the service:

```bash
sudo systemctl restart deckos
journalctl -u deckos -n 200 --no-pager | grep "CPU power metric"
```

If the metric still shows `N/A`, your hardware or kernel may not expose the required sensor data in a way DeckOS can read.

## Updates Do Not Work

Open `Settings` and check the update error shown there.

Common causes:

- `DECKOS_GITHUB_OWNER` or `DECKOS_GITHUB_REPO` is missing
- a private release still requires `DECKOS_GITHUB_TOKEN`
- the configured repository or token is wrong
- GitHub is temporarily unreachable

If you are still using private releases, verify `/etc/deckos/deckos.env`.

## A Compose Stack Will Not Start

Open the app detail page and check the live logs, the compose content, and any environment values or mapped paths. In most cases, the error shown in DeckOS should already tell you why Docker failed to start the app, so start with the message in the UI before dropping to host-level commands.

Also verify the stack directly on the host if needed:

```bash
docker compose -f /var/lib/deckos/apps/<app-id>/docker-compose.yml config
```

If you changed the data directory, use your custom path instead.

## File Actions Fail

File operations may fail because of:

- Linux file permissions
- blocked protected paths
- nonexistent source or destination paths
- trying to paste into a location you cannot write to

If a path is intentionally blocked, DeckOS will return a protection-related error rather than operating on it.

## Reset DeckOS Data

To completely remove DeckOS-managed data:

```bash
sudo systemctl stop deckos
sudo rm -rf /var/lib/deckos
```

Be careful. This removes managed app metadata and compose files. It may also remove app data if you stored that data inside the DeckOS data directory.
