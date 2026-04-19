# Use The Files Browser

The `Files` page gives you browser-based access to the host filesystem. It is designed for practical administration tasks such as moving media, editing config files, checking app folders, and grabbing logs or downloads without opening a terminal. This guide focuses on how to move through the file browser safely and what to expect when DeckOS hits permission or protection boundaries.

## What You Can Do

You can browse directories, pin commonly used folders, jump directly to a path, upload and download files, create folders, rename items, copy and move content, preview supported media, and edit text files. The page is meant to cover normal day-to-day file management rather than every possible system administration scenario. It works best when you treat it as a practical tool for trusted paths instead of a full replacement for root shell access.

## Navigate The Host

1. Use the left sidebar to move between pinned folders and the directory tree. Pinned locations are best for the paths you revisit often, while the tree is useful when you are exploring a new area of the host.
2. Use the path field at the top when you already know where you want to go. This is usually the fastest option for jumping to a specific app or storage path.
3. Use `Up` to move one level higher and `Pin` or `Unpin` to manage shortcuts. This keeps the file browser efficient once you settle into a few common working directories.

## Upload And Download Files

1. Click `Upload` or drag files into the main panel. Both methods send the files into the directory you are currently viewing.
2. Select a single file when you want to download it. DeckOS currently handles individual file downloads rather than full-folder archive downloads.
3. Double-check the current path before uploading. This avoids accidental clutter, especially when you are working inside app data directories.

## Organize Content

1. Select the file or folder you want to work with. Most actions operate on the current selection, so it is worth confirming you have the right item highlighted first.
2. Use `New Folder`, `Rename`, `Copy`, `Cut`, `Paste`, or `Delete` from the toolbar. These are the core organization actions for keeping app data, media, and configs tidy.
3. Be especially careful with delete and move operations on large directories. Those actions can affect real host data, not just DeckOS-managed metadata.

## Hidden Files

Hidden files are off by default. Use the `Hidden` toggle if you need to see them.

## Edit Text Files

1. Open a text-based file such as a compose file, config file, script, or note. DeckOS uses a built-in editor for common text-editing tasks.
2. Review the file before making changes, especially if it belongs to a running service. This helps you avoid editing the wrong config in a similarly named directory.
3. If a file is large, DeckOS may open it in read-only mode first. In that case, you can explicitly opt in to editing once you are sure you want to work with it.

## Preview Media

DeckOS can preview common images, audio files, video files, and PDF files where browser support allows it. For media playback, DeckOS relies on the browser and direct file streaming rather than a custom transcoding layer. That keeps the feature simple and useful for routine verification rather than turning the file browser into a full media server UI.

## Protected Paths

DeckOS intentionally blocks access to certain sensitive system locations.

On Linux, this includes protected areas such as:

- `/proc`
- `/sys`
- `/dev`
- `/run`
- `/var/run`

This is a safety feature. If you hit a blocked-path error, DeckOS is refusing a location that is treated as too sensitive for file-browser access.

Even outside the protected-path list, Linux file permissions still apply. Because DeckOS runs under its own service account, you may need to manually adjust ownership or permissions before DeckOS can read from or write to certain directories.

## Tips

1. Pin your media folders, downloads, and config directories for faster access. A few good pins make the page much more useful.
2. Be careful with copy, move, and delete operations on large directories. These actions affect the real host filesystem and may take time or fail on permission boundaries.
3. Use the built-in editor for quick changes, but keep backups of important config files when appropriate. DeckOS is convenient, but caution is still the right default for system files.
