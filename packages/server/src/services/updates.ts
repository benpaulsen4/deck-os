import { getCurrentVersion } from "../lib/version.js";

type UpdateStatus = {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseName: string | null;
  publishedAt: string | null;
  htmlUrl: string | null;
  lastCheckedAt: string | null;
  error: string | null;
};

type GithubReleaseAsset = {
  id: number;
  name: string;
  content_type: string;
  size: number;
};

type GithubRelease = {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  published_at: string | null;
  assets: GithubReleaseAsset[];
};

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const cleaned = normalizeVersion(v);
  if (cleaned.includes("-")) return null;
  const parts = cleaned.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function getGithubConfig() {
  const owner = process.env.DECKOS_GITHUB_OWNER?.trim() || "";
  const repo = process.env.DECKOS_GITHUB_REPO?.trim() || "";
  const token = process.env.DECKOS_GITHUB_TOKEN?.trim() || "";
  const apiBase = (process.env.DECKOS_GITHUB_API_BASE?.trim() || "https://api.github.com")
    .replace(/\/+$/, "");
  return { owner, repo, token, apiBase };
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "deckos",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
  }

  const json = (await res.json()) as GithubRelease;
  if (!json || typeof json.tag_name !== "string") {
    throw new Error("Invalid GitHub API response");
  }
  return json;
}

const CACHE_MS = 5 * 60 * 1000;
let cached: UpdateStatus | null = null;
let cachedAt = 0;
let inflight: Promise<UpdateStatus> | null = null;

export function clearUpdateStatusCache() {
  cached = null;
  cachedAt = 0;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const currentVersion = getCurrentVersion();
  const { owner, repo } = getGithubConfig();
  const configured = Boolean(owner && repo);

  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    if (!configured) {
      const status: UpdateStatus = {
        enabled: false,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseName: null,
        publishedAt: null,
        htmlUrl: null,
        lastCheckedAt: new Date().toISOString(),
        error: "GitHub updates are not configured",
      };
      cached = status;
      cachedAt = Date.now();
      return status;
    }

    try {
      const rel = await fetchLatestRelease();
      if (rel.draft) {
        throw new Error("Latest release is a draft");
      }
      if (rel.prerelease) {
        throw new Error("Latest release is a prerelease");
      }

      const latest = normalizeVersion(rel.tag_name);
      const cmp = compareSemver(currentVersion, latest);
      const updateAvailable = cmp < 0;

      const status: UpdateStatus = {
        enabled: true,
        currentVersion,
        latestVersion: latest,
        updateAvailable,
        releaseName: rel.name ?? null,
        publishedAt: rel.published_at ?? null,
        htmlUrl: rel.html_url ?? null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      };

      cached = status;
      cachedAt = Date.now();
      return status;
    } catch (err) {
      const status: UpdateStatus = {
        enabled: true,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        releaseName: null,
        publishedAt: null,
        htmlUrl: null,
        lastCheckedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : "Failed to check GitHub releases",
      };
      cached = status;
      cachedAt = Date.now();
      return status;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  clearUpdateStatusCache();
  return await getUpdateStatus();
}

