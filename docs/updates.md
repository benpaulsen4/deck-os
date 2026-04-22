# Update, Roll Back, And Uninstall

DeckOS supports in-app update checks and host-level rollback. The goal is to make routine upgrades simple while still leaving you with a clear escape hatch if a release causes trouble. This page explains the normal update flow, when GitHub credentials still matter, and how to back out safely if you need to.

## Check For Updates

1. Open `Settings` and find the `Updates` panel. This is where DeckOS shows the current version, the latest detected release, and the last successful check time.
2. Click `CHECK NOW` when you want to force a fresh release lookup. This is helpful if you have just published a new release or changed your update configuration.
3. Click `UPDATE NOW` only after reviewing the version information and any error text shown in the panel. DeckOS will only surface this action when it believes an update is available.

## How Updates Work

When DeckOS updates itself:

1. it downloads the selected release tarball
2. it unpacks it into a new release directory
3. it switches `/opt/deckos/current` to the new release
4. it exits so `systemd` can restart it cleanly

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

1. Run the hosted uninstall script on the DeckOS host. Use the same custom paths or service name you used at install time if you changed them.

```bash
curl -fsSL https://script.benpaulsen.tech/uninstall-deckos | sudo bash
```

2. If you installed with custom values, pass them through `bash -s --`:

```bash
curl -fsSL https://script.benpaulsen.tech/uninstall-deckos | sudo bash -s -- --install-root /opt/deckos --data-dir /var/lib/deckos --service-name deckos
```

3. Expect the uninstall script to remove the DeckOS service, `/etc/deckos`, the install root, and the DeckOS data directory. It leaves Docker and Node.js installed.

## Important Uninstall Note

If you installed DeckOS with custom values such as `--install-root`, `--data-dir`, or `--service-name`, use the same values when running the uninstall command. Otherwise, you may remove the wrong service or leave part of the installation behind.

## Before You Update Or Remove DeckOS

1. Confirm you know where your app data lives. This matters most before uninstalling or when you are troubleshooting a failed upgrade.
2. Confirm whether a GitHub token is needed for your chosen release source. Authenticated release sources require more configuration than public ones.
3. Keep the previous release version handy if you expect to roll back. Knowing that target version ahead of time makes recovery much faster.
