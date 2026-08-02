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

  describe("GitHub API base validation", () => {
    test("refuses a plaintext http API base", async () => {
      process.env.DECKOS_GITHUB_OWNER = "deckos";
      process.env.DECKOS_GITHUB_REPO = "deckos";
      process.env.DECKOS_GITHUB_TOKEN = "token";
      process.env.DECKOS_GITHUB_API_BASE = "http://internal.lan/api";

      const updates = await import("./updates.js");
      const status = await updates.getUpdateStatus();

      expect(status.error).toContain("must use https:");
      // The token was never put on the wire.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    test("refuses a malformed API base and one with embedded credentials", async () => {
      process.env.DECKOS_GITHUB_OWNER = "deckos";
      process.env.DECKOS_GITHUB_REPO = "deckos";

      process.env.DECKOS_GITHUB_API_BASE = "not-a-url";
      let updates = await import("./updates.js");
      expect((await updates.getUpdateStatus()).error).toContain("absolute https:// URL");

      vi.resetModules();
      process.env.DECKOS_GITHUB_API_BASE = "https://user:pass@api.example.test";
      updates = await import("./updates.js");
      expect((await updates.getUpdateStatus()).error).toContain("must not embed credentials");
    });

    test("accepts an https API base", async () => {
      process.env.DECKOS_GITHUB_OWNER = "deckos";
      process.env.DECKOS_GITHUB_REPO = "deckos";
      process.env.DECKOS_GITHUB_API_BASE = "https://ghe.example.test/api/v3/";
      vi.mocked(fetch).mockResolvedValue({
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

      expect(status.error).toBeNull();
      expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
        "https://ghe.example.test/api/v3/repos/deckos/deckos/releases/latest"
      );
    });

    test("passes an abort signal on every request", async () => {
      process.env.DECKOS_GITHUB_OWNER = "deckos";
      process.env.DECKOS_GITHUB_REPO = "deckos";
      vi.mocked(fetch).mockResolvedValue({
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
      await updates.getUpdateStatus();

      expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  test("truncates and sanitises a remote error body before surfacing it", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = `<script>${"A".repeat(5000)}</script>  trailing`;
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => hostile,
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.checkForUpdatesNow();

    expect(status.error).toContain("GitHub API error 500");
    expect(status.error).toContain("(truncated)");
    // A couple of hundred characters, not five thousand, and no control bytes.
    expect(status.error?.length).toBeLessThan(300);
    // eslint-disable-next-line no-control-regex
    expect(status.error).not.toMatch(/[\x00-\x1f]/);
    // The full body is still available server-side for debugging.
    expect(consoleSpy).toHaveBeenCalled();
    expect(String(consoleSpy.mock.calls[0]?.[0])).toContain("A".repeat(100));
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

  test("stops sharing an in-flight check that never settles", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetchMock = vi.mocked(fetch);
    // A server that accepts the connection and then never responds: the promise
    // never settles, so `finally` never runs and the slot was never released.
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    const updates = await import("./updates.js");
    void updates.getUpdateStatus().catch(() => undefined);
    void updates.getUpdateStatus().catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    void updates.getUpdateStatus().catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  describe("semver comparison", () => {
    test("orders release versions correctly", async () => {
      const { compareSemver } = await import("./updates.js");

      expect(compareSemver("0.4.3", "0.4.4")).toBeLessThan(0);
      expect(compareSemver("0.5.0", "0.4.9")).toBeGreaterThan(0);
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
      // Build metadata is ignored for precedence.
      expect(compareSemver("1.2.3+build.7", "1.2.3")).toBe(0);
    });

    test("applies semver prerelease precedence rules", async () => {
      const { compareSemver } = await import("./updates.js");

      // A prerelease ranks below the release it precedes: this is the case that
      // silently pinned a `0.4.3-dev` host to "up to date" forever.
      expect(compareSemver("0.4.3-dev", "0.4.3")).toBeLessThan(0);
      expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
      expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
      // Numeric identifiers rank below alphanumeric ones.
      expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
      // A longer identifier set outranks its prefix.
      expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    });

    test("returns null instead of 0 for versions it cannot parse", async () => {
      const { compareSemver, parseSemver } = await import("./updates.js");

      for (const bad of ["1.2.3.4", "0x10", "1e3", "..", "", "v..", "1.2", "01.2.3"]) {
        expect(parseSemver(bad)).toBeNull();
        expect(compareSemver(bad, "1.2.3")).toBeNull();
        expect(compareSemver("1.2.3", bad)).toBeNull();
      }
      // `Number()` used to read these as 16 and 1000.
      expect(parseSemver("0x10.0.0")).toBeNull();
      expect(parseSemver("1e3.0.0")).toBeNull();
    });
  });

  test("reports an error instead of 'up to date' when the release tag is unparseable", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.2.3.4",
        name: "1.2.3.4",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("Cannot compare versions");
    expect(status.error).toContain("released");
  });

  test("reports an error when the installed version is unparseable", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    versionMock.getCurrentVersion.mockReturnValue("0.4.3-dev+local snapshot");
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.5.0",
        name: "0.5.0",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.updateAvailable).toBe(false);
    expect(status.error).toContain("Cannot compare versions");
    expect(status.error).toContain("installed");
  });

  test("offers the update when a prerelease build is behind a stable release", async () => {
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    versionMock.getCurrentVersion.mockReturnValue("0.4.3-dev");
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.4.3",
        name: "0.4.3",
        prerelease: false,
        draft: false,
        html_url: "https://example/release",
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [],
      }),
    } as Response);

    const updates = await import("./updates.js");
    const status = await updates.getUpdateStatus();

    expect(status.error).toBeNull();
    expect(status.updateAvailable).toBe(true);
  });
});
