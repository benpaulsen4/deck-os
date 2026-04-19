import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const versionMock = vi.hoisted(() => ({
  getCurrentVersion: vi.fn(() => "0.2.3"),
}));

vi.mock("../lib/version.js", () => versionMock);

describe("updates service", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...envBackup };
    delete process.env.DECKOS_GITHUB_OWNER;
    delete process.env.DECKOS_GITHUB_REPO;
    delete process.env.DECKOS_GITHUB_TOKEN;
    delete process.env.DECKOS_GITHUB_API_BASE;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  test("returns disabled status when GitHub config is missing", async () => {
    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.enabled).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toBe("GitHub updates are not configured");
  });

  test("reports available update for newer stable release tag", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        name: "0.3.0",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.enabled).toBe(true);
    expect(status.latestVersion).toBe("0.3.0");
    expect(status.updateAvailable).toBe(true);
    expect(status.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("prefers anonymous release checks even when a token is configured", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "stale-token";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        name: "0.3.0",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.latestVersion).toBe("0.3.0");
    expect(status.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({
      headers: expect.objectContaining({
        Authorization: expect.any(String),
      }),
    });
  });

  test("falls back to token when anonymous release checks are rejected", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: "v0.3.0",
          name: "0.3.0",
          prerelease: false,
          draft: false,
          html_url: "https://example/release",
          published_at: "2026-01-01T00:00:00.000Z",
          assets: [],
        }),
      } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.latestVersion).toBe("0.3.0");
    expect(status.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({
      headers: expect.objectContaining({
        Authorization: expect.any(String),
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer token",
      }),
    });
  });

  test("returns safe error status on GitHub API failure", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.checkForUpdatesNow();

    expect(status.enabled).toBe(true);
    expect(status.updateAvailable).toBe(false);
    expect(status.latestVersion).toBeNull();
    expect(status.error).toContain("GitHub API error 500");
  });

  test("returns a helpful auth hint when private release checks fail without a token", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "",
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.checkForUpdatesNow();

    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("GitHub API error 404");
    expect(status.error).toContain("token may still be required");
  });

  test("coalesces concurrent checks into a single fetch call", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    let resolveFetch: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReturnValue(pending);

    const updates = await import("./updates.js");
    const p1 = updates.getUpdateStatus();
    const p2 = updates.getUpdateStatus();

    resolveFetch({
      ok: true,
      json: async () => ({
        tag_name: "v0.2.3",
        name: "0.2.3",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const [a, b] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.latestVersion).toBe("0.2.3");
    expect(b.latestVersion).toBe("0.2.3");
  });
});
