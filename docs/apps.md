# Manage Apps

DeckOS manages apps as Docker Compose stacks. Each app has its own metadata and compose file on disk, which means the UI stays friendly without hiding what is really being run on the host. This guide is about the common app-management tasks most people do every week: adding apps, starting and stopping them, reviewing logs, and making safe edits.

## Add An App From A Template

1. Open `Apps` and choose `+ TEMPLATED APP`. The template library is the fastest path when you want to deploy a common service without writing the compose file from scratch.
2. Search or browse until you find the template you want. Each template is meant to give you a cleaner starting point than pasting a large compose file manually.
3. Open the template detail page and fill in the requested values. This is where you choose the app name, description, icon URL, launch URL, and any template-specific settings such as ports or paths.
4. Review the generated compose file before deployment. This step is useful even when you trust the template, because it shows exactly what DeckOS will save and run.
5. Choose `Deploy` or `Deploy & Start`. The first saves the app without immediately starting containers, while the second creates the app and starts it right away.

## Create A Custom App

1. Open `Apps` and choose `+ CUSTOM APP`. This is the right path when you already have a compose file or want full control from the beginning.
2. Enter the app name, description, icon URL, optional web URL, and the full `docker-compose.yml`. The metadata controls how the app appears inside DeckOS, while the compose file controls what Docker actually runs.
3. Use validation before deploying if you want a quick syntax check. This helps catch obvious YAML problems before the stack hits Docker.
4. Choose `Create & Deploy` once everything looks correct. DeckOS stores the metadata and compose file on disk as a normal managed app.

## What DeckOS Stores

For each app, DeckOS stores `docker-compose.yml` and `metadata.json`. This keeps the app definition transparent and easy to inspect on disk. If you ever need to troubleshoot outside the UI, you are still working with real files instead of a hidden internal database.

## Manage An Existing App

1. Open `Apps` to see the installed app list. This is where you get the quickest overview of status, container counts, and the actions available for each stack.
2. Use the row actions when you want to start, stop, restart, pull updated images, or delete an app. These actions are meant for quick operational tasks without drilling into the detail page.
3. Open the app detail page when you need more context. The detail page gives you container status, live logs, compose editing, and metadata editing in one place.

## App Metadata

App metadata controls how the app appears inside DeckOS, including the display name, description, icon, and launch URL. The launch URL is what powers the `OPEN` action from the dashboard or app detail page. If you want DeckOS to behave like a launcher as well as a manager, keeping this metadata accurate is worth the effort.

## Review Logs And Container State

1. Open the app detail page when a service is not behaving the way you expect. This page combines app-level controls with the information you need to understand what is actually happening.
2. Check the container list and current status first. That tells you whether the stack is down entirely, partially healthy, or restarting repeatedly.
3. Open the live logs next. Logs are usually the fastest way to see startup failures, bad environment variables, missing mounts, port conflicts, or container crashes.

## Editing Compose Files

DeckOS lets you edit an app's compose file directly in the UI. Use this carefully, because the edit affects the real stack definition on disk and syntax problems can prevent the stack from starting. After a meaningful change, restart the app so Docker re-reads the compose file and applies the new configuration.

## Deleting An App

Deleting an app removes the DeckOS-managed app entry and its stored files. Treat this as a destructive action and make sure you understand what persistent volumes the compose stack uses before deleting it.

## Good Habits

1. Add a launch URL for browser-based apps. This makes the dashboard more useful because the tiles become quick entry points instead of just status cards.
2. Keep app names simple and recognizable. A clear app list is easier to scan when you have many stacks running at once.
3. Review generated compose files from templates before deployment. You do not need to distrust templates, but you should understand what is about to run on your server.
4. Use relative volume paths when appropriate. This helps keep app data organized inside the app folder structure managed by DeckOS.
