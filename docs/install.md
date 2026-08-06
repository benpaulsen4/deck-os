# Install DeckOS

DeckOS installs directly on the host as a `systemd` service. It does not run as a Docker container, and it is meant to behave like part of the server rather than as another stack inside Docker. This page explains the normal install flow, what the installer changes on the machine, and what to check when the service comes online.

## Supported Host

- Ubuntu `24.04`
- Ubuntu `25.10`
- Ubuntu `26.04`
- Root access through `sudo`
- A host with `systemd`

## What The Installer Does

The installer can:

- Install Docker if it is missing
- Create a dedicated `deckos` system user
- Install Node.js `24` for that user
- Download the requested DeckOS release from GitHub Releases
- Create the DeckOS service and start it

## Install Command

1. Run the hosted installer on the Ubuntu host you want to manage. This is the preferred install path.

```bash
curl -fsSL https://script.benpaulsen.tech/install-deckos | sudo bash
```

2. Add optional flags only if you need to change the defaults. Pass them through `bash -s --`:

```bash
curl -fsSL https://script.benpaulsen.tech/install-deckos | sudo bash -s -- --port 8080
```

3. Available optional flags:

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

The installer points at `benpaulsen4/deck-os` by default. Use `--owner` and `--repo` only when you want to install from a different fork or release source.
If you want to inspect the installer before running it, download the script first and review it locally.

Re-running the installer is safe. Any value you do not pass again is read back out of the existing `/etc/deckos/deckos.env`, so changing the port does not reset your data directory or discard your GitHub token. The previous env file is backed up alongside it before it is rewritten.

## Release Verification

Every DeckOS release publishes three assets: the `.tar.gz` archive, a `SHA256SUMS` manifest, and a `SHA256SUMS.sig` detached `ed25519` signature over that manifest.

The installer verifies the signature against a public key compiled into the script, then checks the archive against its entry in the manifest, before unpacking anything. There is no flag to skip this. If a release does not publish all three assets, or the signature does not validate, the install stops and nothing is written to `/opt/deckos`.

## When A Token Is Needed

The installer can fetch release metadata and assets without a token when the selected release source allows anonymous access. If the release source requires authentication, provide a token. The installer tries anonymous access first and falls back to the token only when GitHub indicates authentication is needed.

Pass the token by file. This keeps it out of `ps` output and out of your shell history:

```bash
printf '%s' 'ghp_yourtokenhere' | sudo tee /root/deckos-token >/dev/null
sudo chmod 600 /root/deckos-token
curl -fsSL https://script.benpaulsen.tech/install-deckos | sudo bash -s -- --token-file /root/deckos-token
sudo rm -f /root/deckos-token
```

`DECKOS_GITHUB_TOKEN` in the environment works too, and `--token-stdin` reads the token from standard input when you are running a downloaded copy of the script rather than piping it.

Avoid `--token <value>`. It still works, but the value sits in `/proc/<pid>/cmdline` for the whole install — which can be several minutes while Docker and Node.js are installed — where any local user can read it with `ps`, and it is written to your shell history.

## Default Install Layout

- `/opt/deckos/releases/<version>/`: unpacked release directories
- `/opt/deckos/current`: active release symlink
- `/etc/deckos/deckos.env`: runtime configuration
- `/var/lib/deckos/`: persistent data, including managed app data

## After Installation

1. Open DeckOS at `http://<host>/`, or use the custom port you supplied during install.
2. Confirm the service is reachable and the first page loads cleanly.
3. Move to the getting-started guide once you can access the UI.

## First Checks

1. Open the web UI and visit `Settings`. This confirms the service is up and that the frontend can talk to the backend.
2. Verify the hostname, Docker version, and data directory. Those values tell you whether DeckOS sees the host correctly.
3. If you plan to use in-app updates, open `/etc/deckos/deckos.env` and confirm the GitHub owner and repo values are correct for your release source.

## Install Notes

- The installer writes runtime settings to `/etc/deckos/deckos.env`
- If you provide a GitHub token, it is stored there with file mode `600`
- DeckOS adds the `deckos` user to the host `docker` group
- DeckOS also configures passwordless power actions for the service user so restart and shutdown can be triggered from the UI
