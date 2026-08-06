# Update, Roll Back, And Uninstall

DeckOS supports in-app update checks and host-level rollback. The goal is to make routine upgrades simple while still leaving you with a clear escape hatch if a release causes trouble. This page explains the normal update flow, when GitHub credentials still matter, and how to back out safely if you need to.

## Check For Updates

1. Open `Settings` and find the `Updates` panel. This is where DeckOS shows the current version, the latest detected release, and the last successful check time.
2. Click `CHECK NOW` when you want to force a fresh release lookup. This is helpful if you have just published a new release or changed your update configuration.
3. Click `UPDATE NOW` only after reviewing the version information and any error text shown in the panel. DeckOS will only surface this action when it believes an update is available.

## How Updates Work

When DeckOS updates itself:

1. it downloads the release's `SHA256SUMS` manifest and the detached `SHA256SUMS.sig` signature
2. it verifies that signature against the DeckOS release signing key, and stops if it does not match
3. it downloads the selected release tarball and checks its SHA-256 against the signed manifest
4. it confirms the archive really is the version being installed, and inspects every file in it
5. it unpacks it into a new release directory
6. it switches `/opt/deckos/current` to the new release
7. it exits so `systemd` can restart it cleanly

DeckOS keeps the last few releases so you can roll back if needed.

## Release Signing

Every DeckOS release is signed, and each release publishes three assets:

| Asset | What it is |
| --- | --- |
| `deckos-<version>-linux-<arch>.tar.gz` | the release itself |
| `SHA256SUMS` | standard `sha256sum` output listing each artifact |
| `SHA256SUMS.sig` | a raw 64-byte ed25519 signature over `SHA256SUMS` |

DeckOS refuses to install a release it cannot verify. **There is no way to skip verification**, and no setting downgrades a failed check to a warning. This is deliberate: the updater unpacks code that then runs as the `deckos` service user, which is in the `docker` group and can therefore reach root.

You can verify a release by hand using the same public key DeckOS uses, which is published inline in `install.sh`:

```bash
# in a directory holding the tarball, SHA256SUMS and SHA256SUMS.sig
openssl pkeyutl -verify -pubin -inkey deckos-release-signing.pub \
  -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
sha256sum --check --ignore-missing SHA256SUMS
```

### If An Update Fails With A Missing Signature

If `UPDATE NOW` fails with:

```
Release is missing the "SHA256SUMS" asset, so its integrity cannot be verified.
```

the release you are trying to install was published before release signing existed, or was published without the signing secret configured. DeckOS will not install it.

This is expected during the changeover, and it is not something to configure around:

- a release published **before** signing was introduced cannot be installed by a DeckOS version that requires signatures;
- the **first signed release must be published** before a signing-aware host can update at all;
- hosts still running a version that predates signing are unaffected until they move onto a signed release.

The fix is always to publish a signed release, never to bypass the check. If you run your own fork, generate a signing keypair, set the `DECKOS_RELEASE_SIGNING_KEY` repository secret used by the release workflow, and publish the matching public key in `install.sh` and in `packages/server/src/lib/releaseKey.ts`.

### Other Verification Failures

| Message | What it means |
| --- | --- |
| `Release signature verification failed` | `SHA256SUMS` was not signed by the DeckOS release key. Treat the download as untrusted rather than retrying blindly. |
| `Release checksum mismatch` | The tarball does not match the signed manifest. Usually a corrupt or truncated download, but it can also mean the artifact was tampered with. |
| `Release asset ... is not named for version X` | The release's tag and its artifacts disagree. DeckOS refuses it rather than installing one version under another version's number. |
| `Release archive contains deckos-X, not deckos-Y` | The archive is not the version the release claims. Same protection, checked against the archive itself. |
| `Release signature verification is not configured` | The build you are running was compiled without a real signing key. Rebuild from a release that has one. |

## When A Token Is Required

DeckOS checks GitHub Releases using anonymous access first. If the release source requires authentication, you may need `DECKOS_GITHUB_OWNER`, `DECKOS_GITHUB_REPO`, and `DECKOS_GITHUB_TOKEN` configured. If the release source is public, the token can be omitted.

## Manual Rollback

1. If an update causes trouble, point the live symlink back to the previous release. DeckOS keeps recent release directories specifically so this is possible.
2. Restart the service so `systemd` starts the older release again.

```bash
ls /opt/deckos/releases            # see which versions are still on disk
sudo ln -sfn /opt/deckos/releases/<old-version> /opt/deckos/current
sudo systemctl restart deckos
```

After rolling back, the `Updates` panel will offer the newer release again. Clicking `UPDATE NOW` re-links the already-downloaded release and restarts, rather than downloading it a second time.

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
