import { createWriteStream } from "node:fs";
import type { Dirent } from "node:fs";
import { stat, mkdir, rm, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { getUpdateStatus } from "./updates.js";
import { createGithubApiError, requestGithubRelease } from "./githubReleaseApi.js";

type GithubReleaseAsset = {
  id: number;
  name: string;
};

type GithubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubReleaseAsset[];
};

type ApplyUpdateResult = {
  targetVersion: string;
  restarting: boolean;
};

const execFile = promisify(execFileCb);

let updateInProgress = false;

function getInstallRoot(): string {
  return (process.env.DECKOS_INSTALL_ROOT?.trim() || "/opt/deckos").replace(/\/+$/, "");
}

function getUpdateTmpRoot(): string {
  return (process.env.DECKOS_UPDATE_TMP_DIR?.trim() || tmpdir()).replace(/\/+$/, "");
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

async function fetchReleaseByTag(tag: string): Promise<GithubRelease> {
  const { response, tokenConfigured } = await requestGithubRelease(
    `releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!response.ok) {
    throw await createGithubApiError(response, tokenConfigured);
  }
  return (await response.json()) as GithubRelease;
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const { response, tokenConfigured } = await requestGithubRelease("releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw await createGithubApiError(response, tokenConfigured);
  }
  return (await response.json()) as GithubRelease;
}

async function downloadReleaseAsset(assetId: number, destPath: string): Promise<void> {
  const { response, tokenConfigured } = await requestGithubRelease(
    `releases/assets/${assetId}`,
    {
      headers: {
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    }
  );

  if (!response.ok || !response.body) {
    throw await createGithubApiError(response, tokenConfigured);
  }

  await pipeline(
    response.body as unknown as NodeJS.ReadableStream,
    createWriteStream(destPath)
  );
}

function pickAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const preferred = assets.find(
    (a) => a.name.endsWith(".tar.gz") && a.name.includes(`linux-${arch}`)
  );
  const anyTar = assets.find((a) => a.name.endsWith(".tar.gz"));
  const picked = preferred ?? anyTar;
  if (!picked) {
    throw new Error("No .tar.gz release asset found");
  }
  return picked;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isWithinPath(parentPath: string, childPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function getCurrentReleaseVersion(
  currentLink: string,
  releasesDir: string
): Promise<string | null> {
  try {
    const linkedPath = await readlink(currentLink);
    const resolvedPath = isAbsolute(linkedPath)
      ? linkedPath
      : resolve(dirname(currentLink), linkedPath);
    if (!isWithinPath(releasesDir, resolvedPath)) {
      return null;
    }
    const name = basename(resolvedPath).trim();
    return name || null;
  } catch {
    return null;
  }
}

async function pruneReleases(
  releasesDir: string,
  keepVersions: ReadonlySet<string>
): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(releasesDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !keepVersions.has(entry.name))
      .map(async (entry) =>
        rm(join(releasesDir, entry.name), {
          recursive: true,
          force: true,
        })
      )
  );
}

export async function applyUpdate(version?: string): Promise<ApplyUpdateResult> {
  if (updateInProgress) {
    throw new Error("Update already in progress");
  }
  if (process.platform !== "linux") {
    throw new Error("Self-update is only supported on Linux");
  }

  updateInProgress = true;
  let updateWorkDir = "";
  let extractTmp = "";
  try {
    const status = await getUpdateStatus();
    if (!status.enabled) throw new Error(status.error || "Updates are disabled");

    const installRoot = getInstallRoot();
    const releasesDir = join(installRoot, "releases");
    const currentLink = join(installRoot, "current");
    const previousVersion = await getCurrentReleaseVersion(currentLink, releasesDir);

    const tag = version ? `v${normalizeVersion(version)}` : null;
    const release = tag ? await fetchReleaseByTag(tag) : await fetchLatestRelease();
    if (release.draft) throw new Error("Cannot install a draft release");
    if (release.prerelease) throw new Error("Cannot install a prerelease");

    const targetVersion = normalizeVersion(release.tag_name);
    if (!targetVersion) throw new Error("Invalid release tag");

    if (!version && !status.updateAvailable) {
      throw new Error("No update available");
    }

    const asset = pickAsset(release.assets || []);

    const targetDir = join(releasesDir, targetVersion);
    const targetMarker = join(targetDir, "packages", "server", "dist", "index.js");
    if (await pathExists(targetMarker)) {
      return { targetVersion, restarting: false };
    }

    await mkdir(releasesDir, { recursive: true });
    const updateTmpRoot = getUpdateTmpRoot();
    await mkdir(updateTmpRoot, { recursive: true });

    updateWorkDir = join(
      updateTmpRoot,
      `deckos-update-${targetVersion}-${process.pid}-${Date.now()}`
    );
    await rm(updateWorkDir, { recursive: true, force: true });
    await mkdir(updateWorkDir, { recursive: true });

    const tarPath = join(updateWorkDir, `deckos-${targetVersion}.tar.gz`);
    await downloadReleaseAsset(asset.id, tarPath);

    extractTmp = join(releasesDir, `${targetVersion}.tmp`);
    await rm(extractTmp, { recursive: true, force: true });
    await mkdir(extractTmp, { recursive: true });

    await execFile("tar", ["-xzf", tarPath, "-C", extractTmp, "--strip-components=1"]);

    const extractedMarker = join(extractTmp, "packages", "server", "dist", "index.js");
    if (!(await pathExists(extractedMarker))) {
      throw new Error("Release archive missing expected server build output");
    }

    await rm(targetDir, { recursive: true, force: true });
    await execFile("mv", [extractTmp, targetDir]);

    await execFile("ln", ["-sfn", targetDir, currentLink]);
    const keepVersions = new Set([targetVersion]);
    if (previousVersion && previousVersion !== targetVersion) {
      keepVersions.add(previousVersion);
    }
    await pruneReleases(releasesDir, keepVersions);

    setTimeout(() => {
      process.exit(0);
    }, 250);

    return { targetVersion, restarting: true };
  } finally {
    updateInProgress = false;
    if (extractTmp) {
      await rm(extractTmp, { recursive: true, force: true });
    }
    if (updateWorkDir) {
      await rm(updateWorkDir, { recursive: true, force: true });
    }
  }
}
