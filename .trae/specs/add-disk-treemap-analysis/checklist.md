# Checklist
- [x] Settings shows a per-disk action that opens a dedicated disk analysis page for the selected mount
- [x] The analysis page renders a treemap where block area reflects recursive disk usage
- [x] Folder blocks show a name strip at the top and file names are disclosed on hover/focus rather than inline
- [x] The top 20 most common file extensions receive unique colors and the page shows a legend for them
- [x] Disk scans run as bounded multi-worker jobs rather than unbounded recursion or client-side fan-out
- [x] The server streams incremental scan progress and branch results via SSE so the client can update the visualization during the scan
- [x] Completed scans are cached per disk and reused on later visits
- [x] Cached scans older than 24 hours are served immediately while a background regeneration starts
- [x] The user can choose between viewing the stale cached result and the live regenerating result when a stale cache is being refreshed
- [x] Double-clicking a folder block opens the Files page to that folder
- [x] Double-clicking a file block opens the Files page to the containing folder and reveals the target file
- [x] Permission failures, inaccessible paths, and partial-scan errors are surfaced without failing the entire disk analysis flow

