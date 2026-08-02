import { getCurrentVersion } from "../lib/version.js";
import { createGithubApiError, requestGithubRelease } from "./githubReleaseApi.js";

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

export type SemverParts = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  prerelease: string[];
};

/**
 * Strict semver 2.0.0 grammar. Deliberately not `Number()`-based: that accepted
 * `0x10` as major 16, `1e3` as 1000 and the tag `v..` as `0.0.0`.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_IDENTIFIER_RE = /^(0|[1-9]\d*)$/;

export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/** Parses a semver string, returning `null` when it does not parse. */
export function parseSemver(v: string): SemverParts | null {
  if (typeof v !== "string") return null;
  const match = SEMVER_RE.exec(normalizeVersion(v));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // Build metadata (match[5]) is ignored for precedence, per the semver spec.
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** True when `v` is a version string this codebase is willing to act on. */
export function isValidReleaseVersion(v: string): boolean {
  return parseSemver(v) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  // A stable release outranks any prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i];
    const bi = b[i];
    // A larger set of identifiers outranks a smaller one when all else is equal.
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNumeric = NUMERIC_IDENTIFIER_RE.test(ai);
    const bNumeric = NUMERIC_IDENTIFIER_RE.test(bi);
    if (aNumeric && bNumeric) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/**
 * Compares two semver strings.
 *
 * Returns a negative number when `a < b`, zero when equal, a positive number when
 * `a > b`, and **`null` when either side does not parse**. Callers must treat
 * `null` as "unknown" and surface it: returning 0 for unparseable input used to
 * mean a host with a version like `0.4.3-dev` silently reported "up to date" and
 * never updated again.
 *
 * Exported for reuse — `routers/system.ts` currently carries its own local
 * comparison and the two should be consolidated onto this one.
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function getGithubConfig() {
  const owner = process.env.DECKOS_GITHUB_OWNER?.trim() || "";
  const repo = process.env.DECKOS_GITHUB_REPO?.trim() || "";
  return { owner, repo };
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

  const json = (await response.json()) as GithubRelease;
  if (!json || typeof json.tag_name !== "string") {
    throw new Error("Invalid GitHub API response");
  }
  return json;
}

const CACHE_MS = 5 * 60 * 1000;
/**
 * An in-flight check is only shared for this long. Without it a fetch that never
 * settles is handed to every later caller forever; the per-request
 * `AbortSignal.timeout` in githubReleaseApi is the primary defence and this is the
 * backstop.
 */
const INFLIGHT_MAX_AGE_MS = 60 * 1000;

let cached: UpdateStatus | null = null;
let cachedAt = 0;
let inflight: Promise<UpdateStatus> | null = null;
let inflightStartedAt = 0;
let inflightToken: object | null = null;

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
  if (inflight && now - inflightStartedAt < INFLIGHT_MAX_AGE_MS) return inflight;

  const requestToken = {};
  inflightToken = requestToken;
  inflightStartedAt = now;

  inflight = (async () => {
    try {
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
        if (cmp === null) {
          // Never report "up to date" off the back of a version we cannot read.
          const unreadable =
            parseSemver(currentVersion) === null ? "installed" : "released";
          throw new Error(
            `Cannot compare versions: the ${unreadable} version is not valid semver (installed "${currentVersion}", released "${latest}")`
          );
        }

        const status: UpdateStatus = {
          enabled: true,
          currentVersion,
          latestVersion: latest,
          updateAvailable: cmp < 0,
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
      }
    } finally {
      // Only the request that owns the slot may clear it.
      if (inflightToken === requestToken) {
        inflight = null;
        inflightToken = null;
      }
    }
  })();

  return inflight;
}

export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  clearUpdateStatusCache();
  return await getUpdateStatus();
}
