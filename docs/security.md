# Security Notes

DeckOS is admin software for a trusted server environment. Treat it like a control panel with real host power behind it, not like an isolated consumer web app. This page explains the practical security model so you can decide where DeckOS belongs on your network and what precautions matter most.

## The Most Important Thing To Understand

DeckOS needs access to Docker on the host. In practice, that gives it very powerful control over the machine.

That is why DeckOS is best used on:

- a home network
- a private lab
- a trusted internal environment

Do not expose it directly to the public internet unless you fully understand the risks and have added your own network and access controls.

## Optional Passcode Lock

DeckOS includes an optional passcode lock that you can enable from `Settings`.

This is useful for:

- keeping casual local users out
- protecting a shared dashboard inside a trusted network

It is not meant to replace a hardened internet-facing authentication system.

## Host Power Actions

DeckOS can trigger:

- restart
- shutdown

These are intentionally powerful administrative actions. If you enable remote access to DeckOS, understand that the UI can control the host itself.

## File Browser Safety

The file browser blocks access to protected system paths so users cannot casually browse or edit the most sensitive parts of the host.

This improves safety, but it does not make DeckOS a sandbox. DeckOS also runs as its own service account, which means normal Linux file permissions still apply. If DeckOS cannot read from or write to a path you expect to manage, you may need to adjust ownership or permissions on that path so the `deckos` user can access it safely.

## Tokens And Secrets

If you use a GitHub token for private releases:

- store it only where needed
- keep `/etc/deckos/deckos.env` readable only by privileged users
- rotate the token if you suspect it has been exposed

## Good Practices

- Keep DeckOS on a trusted network
- Use the passcode lock if other people can reach the UI
- Limit who can reach the host and its port
- Review compose files before deploying them
- Be careful with templates that include default credentials or exposed services
