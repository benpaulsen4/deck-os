import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const updatesMock = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
}));

const fsPromisesMock = vi.hoisted(() => ({
  stat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
}));

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => cb(null, "", "")
  ),
}));

const pipelineMock = vi.hoisted(() => vi.fn(async () => undefined));
const createWriteStreamMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("./updates.js", () => updatesMock);
vi.mock("node:fs/promises", () => fsPromisesMock);
vi.mock("node:child_process", () => childProcessMock);
vi.mock("node:stream/promises", () => ({
  pipeline: pipelineMock,
}));
vi.mock("node:fs", () => ({
  createWriteStream: createWriteStreamMock,
}));

async function importSelfUpdate() {
  vi.resetModules();
  return await import("./selfUpdate.js");
}

describe("selfUpdate service", () => {
  const originalPlatform = process.platform;
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...envBackup };
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.unstubAllGlobals();
  });

  test("rejects self-update on non-linux platforms", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { applyUpdate } = await importSelfUpdate();

    await expect(applyUpdate()).rejects.toThrow("Self-update is only supported on Linux");
  });

  test("returns without restart when target release is already installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: true,
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 1, name: "deckos-linux-x64.tar.gz" }],
      }),
    } as Response);
    fsPromisesMock.readlink.mockResolvedValue("/opt/deckos/releases/0.2.3");
    fsPromisesMock.stat.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      if (normalized.endsWith("/releases/0.3.0/packages/server/dist/index.js")) {
        return {} as any;
      }
      throw new Error("ENOENT");
    });

    const { applyUpdate } = await importSelfUpdate();
    const result = await applyUpdate();

    expect(result).toEqual({ targetVersion: "0.3.0", restarting: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("rejects draft release installation", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: true,
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        draft: true,
        prerelease: false,
        assets: [{ id: 1, name: "deckos-linux-x64.tar.gz" }],
      }),
    } as Response);
    fsPromisesMock.readlink.mockResolvedValue("/opt/deckos/releases/0.2.3");
    fsPromisesMock.stat.mockRejectedValue(new Error("ENOENT"));

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow("Cannot install a draft release");
  });

  test("prevents concurrent update executions", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    let resolveStatus:
      | ((value: { enabled: boolean; updateAvailable: boolean; error: string }) => void)
      | undefined;
    updatesMock.getUpdateStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );

    const { applyUpdate } = await importSelfUpdate();
    const first = applyUpdate();
    await Promise.resolve();

    await expect(applyUpdate()).rejects.toThrow("Update already in progress");

    resolveStatus?.({ enabled: false, updateAvailable: false, error: "Updates disabled" });
    await expect(first).rejects.toThrow("Updates disabled");
  });

  test("runs full linux update workflow and schedules restart", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";
    process.env.DECKOS_INSTALL_ROOT = "/opt/deckos";
    process.env.DECKOS_UPDATE_TMP_DIR = "/tmp";

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: true,
      error: null,
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: "v0.4.0",
          draft: false,
          prerelease: false,
          assets: [{ id: 42, name: "deckos-linux-x64.tar.gz" }],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        body: {} as ReadableStream<Uint8Array>,
      } as Response);

    fsPromisesMock.readlink.mockResolvedValue("/opt/deckos/releases/0.3.0");
    fsPromisesMock.stat.mockImplementation(async (p: string) => {
      const normalized = p.replace(/\\/g, "/");
      if (normalized.endsWith("/releases/0.4.0/packages/server/dist/index.js")) {
        throw new Error("ENOENT");
      }
      if (normalized.endsWith("/releases/0.4.0.tmp/packages/server/dist/index.js")) {
        return {} as any;
      }
      throw new Error("ENOENT");
    });
    fsPromisesMock.readdir.mockResolvedValue([
      { name: "0.2.0", isDirectory: () => true },
      { name: "0.3.0", isDirectory: () => true },
      { name: "0.4.0", isDirectory: () => true },
    ] as any);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((() => undefined) as unknown) as never);

    const { applyUpdate } = await importSelfUpdate();
    const result = await applyUpdate();

    expect(result).toEqual({ targetVersion: "0.4.0", restarting: true });
    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "tar",
      expect.arrayContaining(["-xzf"]),
      expect.any(Function)
    );
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      "mv",
      expect.any(Array),
      expect.any(Function)
    );
    const lnCall = childProcessMock.execFile.mock.calls.find(
      (call: unknown[]) => call[0] === "ln"
    );
    expect(lnCall).toBeTruthy();
    const lnArgs = (lnCall?.[1] as string[]).map((value) => value.replace(/\\/g, "/"));
    expect(lnArgs[0]).toBe("-sfn");
    expect(lnArgs[1]).toBe("/opt/deckos/releases/0.4.0");
    expect(lnArgs[2]).toBe("/opt/deckos/current");
    const removedPaths = fsPromisesMock.rm.mock.calls.map((call: unknown[]) =>
      String(call[0]).replace(/\\/g, "/")
    );
    expect(removedPaths).toContain("/opt/deckos/releases/0.2.0");

    vi.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });

  test("throws when no update is available for implicit latest install", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: false,
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 1, name: "deckos-linux-x64.tar.gz" }],
      }),
    } as Response);
    fsPromisesMock.readlink.mockResolvedValue("/opt/deckos/releases/0.2.3");
    fsPromisesMock.stat.mockRejectedValue(new Error("ENOENT"));

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow("No update available");
  });

  test("throws when versioned release does not contain tarball assets", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_GITHUB_TOKEN = "token";

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: false,
      error: null,
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.5.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 100, name: "notes.txt" }],
      }),
    } as Response);
    fsPromisesMock.readlink.mockResolvedValue("/opt/deckos/releases/0.4.0");
    fsPromisesMock.stat.mockRejectedValue(new Error("ENOENT"));

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate("0.5.0")).rejects.toThrow("No .tar.gz release asset found");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain("/releases/tags/v0.5.0");
  });
});
