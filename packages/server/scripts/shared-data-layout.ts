/**
 * Linux refuses hardlinks across mount points, even between two folders on the
 * same disk, so mounting downloads and the library separately makes every import
 * a full copy. These templates mount one parent at `/data` instead. CasaOS ships
 * the split layout, and the importer empties the output folder, so the layout
 * lives here to be re-applied on every import.
 */

export const SHARED_DATA_TARGET = "/data";

/**
 * Absolute on purpose: a relative default resolves inside each app's own folder,
 * which would give every app a private `/data` that the others cannot see.
 */
export const SHARED_DATA_DEFAULT_SOURCE = "/srv/data";

export const SHARED_DATA_PARAMETER_DESCRIPTION =
  "Host folder mounted at /data. Use the same path for all your media apps and keep it on one filesystem, with downloads/ and media/ inside it. It must be writable by PUID/PGID.";

type SharedDataApp = {
  /** Upstream mount targets that the single `/data` mount replaces. */
  replacesTargets: string[];
  /** Appended to the template description. */
  guidance: string;
};

function importerApp(
  appName: string,
  libraryTarget: string,
  libraryFolder: string
): SharedDataApp {
  return {
    replacesTargets: [libraryTarget, "/downloads"],
    guidance: `For hardlinked imports, give this app and your download client the same DATA path. In ${appName}, use /data/media/${libraryFolder} as the library folder.`,
  };
}

function downloadClient(
  appName: string,
  saveSetting: string,
  replacesTarget = "/downloads"
): SharedDataApp {
  return {
    replacesTargets: [replacesTarget],
    guidance: `For hardlinked imports, give this app and Sonarr/Radarr the same DATA path. In ${appName}, set ${saveSetting} to /data/downloads.`,
  };
}

export const SHARED_DATA_APPS: Record<string, SharedDataApp> = {
  sonarr: importerApp("Sonarr", "/tv", "tv"),
  radarr: importerApp("Radarr", "/movies", "movies"),
  lidarr: importerApp("Lidarr", "/music", "music"),
  readarr: importerApp("Readarr", "/books", "books"),
  medusa: importerApp("Medusa", "/tv", "tv"),
  sickchill: importerApp("SickChill", "/tv", "tv"),
  mylar3: importerApp("Mylar", "/comics", "comics"),
  lazylibrarian: importerApp("LazyLibrarian", "/books", "books"),
  // Never hardlinks, but Sonarr and Radarr report library paths to it, so it has
  // to see them at the same place to work without path mappings.
  bazarr: {
    replacesTargets: ["/tv", "/movies"],
    guidance:
      "Give this app the same DATA path as Sonarr and Radarr so their library paths match here without path mappings.",
  },
  // A client reports where it saved a file, and the importer opens that exact
  // path, so clients must move to /data along with the importers.
  qbittorrent: downloadClient("qBittorrent", "the default save path"),
  transmission: downloadClient("Transmission", "the download folder"),
  deluge: downloadClient("Deluge", "the download folder", "/DATA"),
  sabnzbd: downloadClient("SABnzbd", "the completed download folder"),
  nzbget: downloadClient("NZBGet", "MainDir"),
};

function getVolumeTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry.split(":")[1] ?? null;
  if (entry && typeof entry === "object") {
    const target = (entry as Record<string, unknown>).target;
    return typeof target === "string" ? target : null;
  }
  return null;
}

/** Swaps a service's split mounts for one `/data` mount, keeping its position. */
export function applySharedDataVolumes(
  templateId: string,
  volumes: unknown[]
): unknown[] {
  const app = SHARED_DATA_APPS[templateId];
  if (!app) return volumes;

  let added = false;
  const result: unknown[] = [];
  for (const entry of volumes) {
    const target = getVolumeTarget(entry);
    if (target === null || !app.replacesTargets.includes(target)) {
      result.push(entry);
    } else if (!added) {
      added = true;
      result.push({
        type: "bind",
        source: SHARED_DATA_DEFAULT_SOURCE,
        target: SHARED_DATA_TARGET,
      });
    }
  }
  return result;
}

export function applySharedDataDescription(
  templateId: string,
  description: string
): string {
  const app = SHARED_DATA_APPS[templateId];
  if (!app) return description;
  return description ? `${description} ${app.guidance}` : app.guidance;
}
