# Get Started

This page walks through the first things most people do after opening DeckOS. It is written for someone who has just finished installation and wants to understand the product from the user interface outward. By the end of this guide, you should know where to look for system health, where to deploy apps, where to manage files, and where to adjust the system-wide settings.

## Main Areas

DeckOS has four main pages:

- `Dashboard`: live system overview and app launcher
- `Apps`: install, deploy, and manage app stacks
- `Files`: browse and edit host files
- `Settings`: system details, updates, and security

## Dashboard

The dashboard is your at-a-glance home page. It shows:

- CPU, memory, disk, and network activity
- hostname, uptime, operating system, and Docker version
- launch tiles for installed apps

If an app has a configured web URL, its tile can open that app in a new browser tab.

## Apps

Go to `Apps` when you want to:

- create a custom app from your own compose file
- deploy from the template library
- start, stop, restart, or delete an app
- pull the latest container images
- open logs, edit metadata, or change compose content

If no apps are installed yet, start with the template library or create a custom app.

## Files

Use `Files` to work with the host filesystem.

You can:

- browse directories from a sidebar tree
- pin common folders
- upload and download files
- create folders
- rename, copy, cut, paste, and delete items
- preview supported media
- edit text files

## Settings

Use `Settings` to:

- review system information and disk usage
- check for DeckOS updates
- apply an available update
- view the data directory path
- enable, change, or disable the passcode lock

## A Good First Session

1. Open `Settings` and confirm the server information looks correct. This is the fastest way to verify that DeckOS sees the host, the operating system, and Docker as expected.
2. Check that Docker is visible in the system information. If Docker is missing or unavailable here, fix that before trying to deploy apps.
3. Open `Apps` and choose either a template or a custom compose file. This is where most people begin turning DeckOS into something useful.
4. Deploy a simple app and wait for the stack to come online. Once it is running, return to `Dashboard` and confirm the app appears as a launcher tile.
5. Open `Files` and pin any directories you expect to use often. Doing this early makes later compose edits, downloads, and media access much easier.

## If You Get Stuck

- For update issues, see [Update, Roll Back, and Uninstall](updates.md)
- For file access problems, see [Use the Files Browser](files.md)
- For operational issues, see [Troubleshooting](troubleshooting.md)
