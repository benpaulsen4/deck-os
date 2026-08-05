# Update, Roll Back, And Uninstall

DeckOS supports in-app update checks and host-level rollback. The goal is to make routine upgrades simple while still leaving you with a clear escape hatch if a release causes trouble. This page explains the normal update flow, when GitHub credentials still matter, and how to back out safely if you need to.

## Check For Updates

1. Open `Settings` and find the `Updates` panel. This is where DeckOS shows the current version, the latest detected release, and the last successful check time.
2. Click `CHECK NOW` when you want to force a fresh release lookup. This is helpful if you have just published a new release or changed your update configuration.
3. Click `UPDATE NOW` only after reviewing the version information and any error text shown in the panel. DeckOS will only surface this action when it believes an update is available.

## How Updates Work

When DeckOS updates itself:

1. it downloads the selected release tarball, plus the `SHA256SUMS` manifest and its `SHA256SUMS.sig` signature
2. it verifies the `ed25519` signature over the manifest, then checks the tarball against its entry in that manifest
3. it unpacks the verified tarball into a new release directory
4. it switches `/opt/deckos/current` to the new release
5. it exits so `systemd` can restart it cleanly

Verification is not optional. If a release does not publish all three assets, or the signature does not validate, the update stops before anything is unpacked and the running release is left untouched.

DeckOS keeps the previous release so you can roll back if needed.

## When A Token Is Required

DeckOS checks GitHub Releases using anonymous access first. If the release source requires authentication, you may need `DECKOS_GITHUB_OWNER`, `DECKOS_GITHUB_REPO`, and `DECKOS_GITHUB_TOKEN` configured. If the release source is public, the token can be omitted.

## Manual Rollback

1. If an update causes trouble, point the live symlink back to the previous release. DeckOS keeps the prior release directory specifically so this is possible.
2. Restart the service so `systemd` starts the older release again.

```bash
sudo ln -sfn /opt/deckos/releases/<old-version> /opt/deckos/current
sudo systemctl restart deckos
```

## Uninstall

1. Run the hosted uninstall script on the DeckOS host. It reads your install root and data directory back out of `/etc/deckos/deckos.env`, so you no longer have to remember what you passed at install time.

```bash
curl -fsSL https://script.benpaulsen.tech/uninstall-deckos | sudo bash
```

2. The script prints exactly what it is about to delete and waits for confirmation. It reads your answer from `/dev/tty`, so it still prompts normally when piped from an interactive shell. Pass `--yes` to skip the prompt, which you will need in a script, a CI job, or anywhere else with no controlling terminal. Use `--dry-run` first if you want to see the plan without removing anything:

```bash
curl -fsSL https://script.benpaulsen.tech/uninstall-deckos | sudo bash -s -- --dry-run
```

3. Override the detected values only if you need to. `--keep-data` preserves the data directory:

```bash
curl -fsSL https://script.benpaulsen.tech/uninstall-deckos | sudo bash -s -- \
  --install-root /opt/deckos --data-dir /var/lib/deckos --service-name deckos --keep-data --yes
```

4. Expect the uninstall script to remove:

- the DeckOS `systemd` unit (stopped, disabled, then deleted)
- `/etc/sudoers.d/deckos-power`, the passwordless reboot and shutdown rule
- `/usr/local/bin/deckos-node` and `/usr/local/bin/deckos-fix-cpu-power-perms`
- `/etc/deckos`
- the install root
- the data directory, unless `--keep-data` was passed
- the `deckos` user and group

It leaves Docker and Node.js installed.

## Important Uninstall Note

The uninstall script defaults to the paths recorded in `/etc/deckos/deckos.env` and refuses paths that are not plausibly DeckOS directories, so a mistyped `--data-dir /var/lib` is rejected rather than acted on. Passing custom values is still only necessary when the env file is missing or you are removing an install whose paths have since changed.

## Before You Update Or Remove DeckOS

1. Confirm you know where your app data lives. This matters most before uninstalling or when you are troubleshooting a failed upgrade.
2. Confirm whether a GitHub token is needed for your chosen release source. Authenticated release sources require more configuration than public ones.
3. Keep the previous release version handy if you expect to roll back. Knowing that target version ahead of time makes recovery much faster.
