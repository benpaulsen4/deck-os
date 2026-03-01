import { createWriteStream } from "node:fs";
import { stat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { getUpdateStatus } from "./updates.js";

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

function getGithubConfig() {
  const owner = process.env.DECKOS_GITHUB_OWNER?.trim() || "";
  const repo = process.env.DECKOS_GITHUB_REPO?.trim() || "";
  const token = process.env.DECKOS_GITHUB_TOKEN?.trim() || "";
  const apiBase = (
    process.env.DECKOS_GITHUB_API_BASE?.trim() || "https://api.github.com"
  ).replace(/\/+$/, "");
  return { owner, repo, token, apiBase };
}

function getInstallRoot(): string {
  return (process.env.DECKOS_INSTALL_ROOT?.trim() || "/opt/deckos").replace(/\/+$/, "");
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

async function fetchReleaseByTag(tag: string): Promise<GithubRelease> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  if (!owner || !repo) throw new Error("GitHub updates are not configured");
  if (!token) throw new Error("GitHub token is not configured");

  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "deckos",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as GithubRelease;
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  if (!owner || !repo) throw new Error("GitHub updates are not configured");
  if (!token) throw new Error("GitHub token is not configured");

  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "deckos",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as GithubRelease;
}

async function downloadReleaseAsset(assetId: number, destPath: string): Promise<void> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${assetId}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "deckos",
      Authorization: `Bearer ${token}`,
    },
    redirect: "follow",
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to download asset ${assetId}: ${res.status} ${text || res.statusText}`
    );
  }

  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
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

export async function applyUpdate(version?: string): Promise<ApplyUpdateResult> {
  if (updateInProgress) {
    throw new Error("Update already in progress");
  }
  if (process.platform !== "linux") {
    throw new Error("Self-update is only supported on Linux");
  }

  updateInProgress = true;
  try {
    const status = await getUpdateStatus();
    if (!status.enabled) throw new Error(status.error || "Updates are disabled");

    const installRoot = getInstallRoot();
    const releasesDir = join(installRoot, "releases");
    const currentLink = join(installRoot, "current");
    const tmpDir = join(installRoot, "tmp");

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
    await mkdir(tmpDir, { recursive: true });

    const tarPath = join(tmpDir, `deckos-${targetVersion}.tar.gz`);
    await rm(tarPath, { force: true });

    await downloadReleaseAsset(asset.id, tarPath);

    const extractTmp = join(releasesDir, `${targetVersion}.tmp`);
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

    setTimeout(() => {
      process.exit(0);
    }, 250);

    return { targetVersion, restarting: true };
  } finally {
    updateInProgress = false;
  }
}
