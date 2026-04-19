const AUTH_RETRY_STATUSES = new Set([401, 403, 404]);

export function getGithubConfig() {
  const owner = process.env.DECKOS_GITHUB_OWNER?.trim() || "";
  const repo = process.env.DECKOS_GITHUB_REPO?.trim() || "";
  const token = process.env.DECKOS_GITHUB_TOKEN?.trim() || "";
  const apiBase = (
    process.env.DECKOS_GITHUB_API_BASE?.trim() || "https://api.github.com"
  ).replace(/\/+$/, "");
  return { owner, repo, token, apiBase };
}

type GithubRequestOptions = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

function shouldRetryWithToken(status: number, token: string): boolean {
  return token.length > 0 && AUTH_RETRY_STATUSES.has(status);
}

export async function requestGithubRelease(
  path: string,
  options: GithubRequestOptions
): Promise<{ response: Response; tokenConfigured: boolean }> {
  const { owner, repo, token, apiBase } = getGithubConfig();
  if (!owner || !repo) {
    throw new Error("GitHub updates are not configured");
  }

  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`;
  const headers = {
    "User-Agent": "deckos",
    ...options.headers,
  };

  const anonymousResponse = await fetch(url, {
    ...options,
    headers,
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
  });
  return { response: tokenResponse, tokenConfigured: true };
}

export async function createGithubApiError(
  response: Response,
  tokenConfigured: boolean
): Promise<Error> {
  const text = await response.text().catch(() => "");
  const detail = text || response.statusText || "Request failed";

  let hint = "";
  if (AUTH_RETRY_STATUSES.has(response.status)) {
    hint = tokenConfigured
      ? " Check repository visibility and GitHub token configuration."
      : " A GitHub token may still be required while releases remain private.";
  }

  return new Error(`GitHub API error ${response.status}: ${detail}${hint}`);
}
