const AUTH_RETRY_STATUSES = new Set([401, 403, 404]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_API_BASE = "https://api.github.com";
const USER_AGENT = "deckos";

/** Metadata calls are small; a hung one must not wedge the update flow. */
export const GITHUB_METADATA_TIMEOUT_MS = 20_000;
/** Asset downloads stream, so the ceiling is an overall deadline, not idle time. */
export const GITHUB_ASSET_TIMEOUT_MS = 10 * 60_000;

const MAX_ASSET_REDIRECTS = 5;
/** Never buffer more than this much of a remote error body. */
const MAX_ERROR_BODY_READ_BYTES = 8 * 1024;
/** Never surface more than this much of a remote error body to the client. */
const MAX_ERROR_BODY_CHARS = 200;

type GithubRequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

/**
 * Resolves `DECKOS_GITHUB_API_BASE`.
 *
 * The base is operator-supplied but ends up carrying a PAT and delivering code
 * that gets executed, so it is validated at read time: an absolute `https:` URL
 * with no embedded credentials. A plain-`http:` base would leak the token and
 * fetch the tarball over an unauthenticated channel.
 */
function resolveApiBase(): string {
  const raw = process.env.DECKOS_GITHUB_API_BASE?.trim() || DEFAULT_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "DECKOS_GITHUB_API_BASE must be an absolute https:// URL (for example https://api.github.com)"
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `DECKOS_GITHUB_API_BASE must use https: (got "${parsed.protocol}"). Refusing to send credentials or fetch release code over an unencrypted channel.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("DECKOS_GITHUB_API_BASE must not embed credentials");
  }
  return raw.replace(/\/+$/, "");
}

export function getGithubConfig() {
  const owner = process.env.DECKOS_GITHUB_OWNER?.trim() || "";
  const repo = process.env.DECKOS_GITHUB_REPO?.trim() || "";
  const token = process.env.DECKOS_GITHUB_TOKEN?.trim() || "";
  const apiBase = resolveApiBase();
  return { owner, repo, token, apiBase };
}

function shouldRetryWithToken(status: number, token: string): boolean {
  return token.length > 0 && AUTH_RETRY_STATUSES.has(status);
}

function buildRepoUrl(apiBase: string, owner: string, repo: string, path: string): string {
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`;
}

export async function requestGithubRelease(
  path: string,
  options: GithubRequestOptions
): Promise<{ response: Response; tokenConfigured: boolean }> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  if (!owner || !repo) {
    throw new Error("GitHub updates are not configured");
  }

  const url = buildRepoUrl(apiBase, owner, repo, path);
  const headers = {
    "User-Agent": USER_AGENT,
    ...options.headers,
  };
  const signal = options.signal ?? AbortSignal.timeout(GITHUB_METADATA_TIMEOUT_MS);

  const anonymousResponse = await fetch(url, {
    ...options,
    headers,
    signal,
  });
  if (anonymousResponse.ok || !shouldRetryWithToken(anonymousResponse.status, token)) {
    return { response: anonymousResponse, tokenConfigured: token.length > 0 };
  }

  const tokenResponse = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      Authorization: `Bearer ${token}`,
    },
    signal,
  });
  return { response: tokenResponse, tokenConfigured: true };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing useful to do if the socket is already gone.
  }
}

/**
 * Performs a release-asset GET, following redirects by hand.
 *
 * `redirect: "follow"` would hand the hop chain to undici; cross-origin
 * `Authorization` stripping would then be the only thing keeping the PAT off the
 * redirect target, which is a property of undici's spec compliance rather than
 * anything this code guarantees. Following manually means the credential is only
 * ever sent to the configured API base, and every hop is required to be https.
 */
async function fetchAssetFollowingRedirects(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = url;
  let currentHeaders = headers;

  for (let hop = 0; hop <= MAX_ASSET_REDIRECTS; hop += 1) {
    const response = await fetch(currentUrl, {
      method: "GET",
      headers: currentHeaders,
      redirect: "manual",
      signal,
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    await discardBody(response);
    if (!location) {
      throw new Error(
        `Release asset download returned HTTP ${response.status} without a Location header`
      );
    }

    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error("Release asset download returned an unusable redirect target");
    }
    if (next.protocol !== "https:") {
      throw new Error(
        `Refusing to follow a release asset redirect to a non-https target (${next.protocol})`
      );
    }

    currentUrl = next.toString();
    // Credentials are never replayed to a redirect target, whatever its origin.
    currentHeaders = {
      "User-Agent": USER_AGENT,
      Accept: "application/octet-stream",
    };
  }

  throw new Error("Too many redirects while downloading the release asset");
}

/**
 * Downloads a release asset by id. Keeps the existing anonymous-then-token
 * behaviour for private repositories.
 */
export async function requestGithubReleaseAsset(
  assetId: number,
  options?: { signal?: AbortSignal }
): Promise<{ response: Response; tokenConfigured: boolean }> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  if (!owner || !repo) {
    throw new Error("GitHub updates are not configured");
  }

  const url = buildRepoUrl(apiBase, owner, repo, `releases/assets/${assetId}`);
  const signal = options?.signal ?? AbortSignal.timeout(GITHUB_ASSET_TIMEOUT_MS);
  const baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/octet-stream",
  };

  const anonymousResponse = await fetchAssetFollowingRedirects(url, baseHeaders, signal);
  if (anonymousResponse.ok || !shouldRetryWithToken(anonymousResponse.status, token)) {
    return { response: anonymousResponse, tokenConfigured: token.length > 0 };
  }

  await discardBody(anonymousResponse);
  const tokenResponse = await fetchAssetFollowingRedirects(
    url,
    { ...baseHeaders, Authorization: `Bearer ${token}` },
    signal
  );
  return { response: tokenResponse, tokenConfigured: true };
}

/** Reads at most `limit` bytes of a response body without buffering the rest. */
async function readBodyPreview(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text().catch(() => "");
    return text.slice(0, limit);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // Partial preview is fine.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, limit);
}

/**
 * Collapses a remote-controlled string into something safe to render in the panel:
 * control characters removed, whitespace collapsed, hard length cap.
 */
function summarizeRemoteText(value: string): string {
  const collapsed = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= MAX_ERROR_BODY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`;
}

export async function createGithubApiError(
  response: Response,
  tokenConfigured: boolean
): Promise<Error> {
  const raw = await readBodyPreview(response, MAX_ERROR_BODY_READ_BYTES).catch(() => "");
  if (raw) {
    // Full (bounded) body stays server-side; only a short summary reaches the UI.
    console.error(`[deckos] GitHub API error ${response.status} body: ${raw}`);
  }

  const detail =
    summarizeRemoteText(raw) ||
    summarizeRemoteText(response.statusText || "") ||
    "Request failed";

  let hint = "";
  if (AUTH_RETRY_STATUSES.has(response.status)) {
    hint = tokenConfigured
      ? " Check repository visibility and GitHub token configuration."
      : " A GitHub token may still be required while releases remain private.";
  }

  return new Error(`GitHub API error ${response.status}: ${detail}${hint}`);
}
