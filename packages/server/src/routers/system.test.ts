import { beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

const { applyUpdateMock, getCurrentVersionMock, metricsMock } = vi.hoisted(() => ({
  applyUpdateMock: vi.fn(async (_version?: string) => ({
    targetVersion: "9.9.9",
    restarting: true,
  })),
  getCurrentVersionMock: vi.fn(() => "0.4.3"),
  metricsMock: {
    getMetricsSnapshot: vi.fn(async () => ({ timestamp: "cached" })),
    getOneShotMetrics: vi.fn(async () => ({ timestamp: "collected" })),
  },
}));

vi.mock("../services/selfUpdate.js", () => ({ applyUpdate: applyUpdateMock }));
vi.mock("../lib/version.js", () => ({ getCurrentVersion: getCurrentVersionMock }));
vi.mock("../services/metrics.js", () => metricsMock);

import { compareStrictSemver, runPowerAction, systemRouter } from "./system.js";

const caller = systemRouter.createCaller({
  authEnabled: false,
  isAuthenticated: true,
  sessionToken: null,
  clientIp: "127.0.0.1",
});

type PlannedResult =
  | { type: "exit"; code: number | null; signal?: NodeJS.Signals | null }
  | { type: "error"; message: string };

function createSpawnStub(
  plan: PlannedResult[],
  calls: Array<{ command: string; args: string[] }>
): typeof spawn {
  let index = 0;
  return ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const next = plan[index++] ?? { type: "exit", code: 0 };
    queueMicrotask(() => {
      if (next.type === "error") {
        child.emit("error", new Error(next.message));
        return;
      }
      child.emit("exit", next.code, next.signal ?? null);
    });
    return child;
  }) as typeof spawn;
}

test("runPowerAction uses sudo first for non-root linux commands", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnStub = createSpawnStub([{ type: "exit", code: 0 }], calls);

  await runPowerAction("shutdown", {
    spawnImpl: spawnStub,
    platform: "linux",
    uid: 1001,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe("sudo");
  expect(calls[0].args).toEqual(["-n", "/usr/bin/systemctl", "poweroff"]);
});

test("runPowerAction falls back to direct command when sudo attempt fails", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnStub = createSpawnStub(
    [
      { type: "error", message: "sudo failed" },
      { type: "exit", code: 0 },
    ],
    calls
  );

  await runPowerAction("restart", {
    spawnImpl: spawnStub,
    platform: "linux",
    uid: 1001,
  });

  expect(calls).toHaveLength(2);
  expect(calls[0].command).toBe("sudo");
  expect(calls[1].command).toBe("/usr/bin/systemctl");
  expect(calls[1].args).toEqual(["reboot"]);
});

test("runPowerAction rejects when command exits non-zero", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnStub = createSpawnStub(
    [
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
      { type: "exit", code: 1 },
    ],
    calls
  );

  await expect(
    runPowerAction("shutdown", {
      spawnImpl: spawnStub,
      platform: "linux",
      uid: 1001,
    })
  ).rejects.toThrow(/Unable to execute shutdown command/);
  expect(calls.length).toBeGreaterThanOrEqual(2);
});

describe("system.getMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("serves the cached snapshot instead of forcing a fresh collection", async () => {
    const result = await caller.getMetrics();

    expect(result).toEqual({ timestamp: "cached" });
    expect(metricsMock.getMetricsSnapshot).toHaveBeenCalledTimes(1);
    expect(metricsMock.getOneShotMetrics).not.toHaveBeenCalled();
  });
});

describe("system.applyUpdate version handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentVersionMock.mockReturnValue("0.4.3");
  });

  test("compareStrictSemver orders releases numerically and rejects junk", () => {
    expect(compareStrictSemver("0.5.0", "0.4.3")).toBeGreaterThan(0);
    expect(compareStrictSemver("0.4.10", "0.4.9")).toBeGreaterThan(0);
    expect(compareStrictSemver("v0.4.3", "0.4.3")).toBe(0);
    expect(compareStrictSemver("0.4.2", "0.4.3")).toBeLessThan(0);
    expect(compareStrictSemver("0.4", "0.4.3")).toBeNull();
    expect(compareStrictSemver("1.0.0-rc.1", "0.4.3")).toBeNull();
  });

  test.each([
    "latest",
    "0.4",
    "0.4.3.1",
    "01.2.3",
    "1.2.3-rc.1",
    "0.4.3 && reboot",
    "../../etc/passwd",
    "",
  ])("rejects non-semver version %j at the input boundary", async (version) => {
    await expect(caller.applyUpdate({ version })).rejects.toThrow();
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });

  test("refuses an explicit downgrade", async () => {
    await expect(caller.applyUpdate({ version: "0.1.0" })).rejects.toThrow(
      /not newer than the running version/
    );
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });

  test("refuses a reinstall of the running version", async () => {
    await expect(caller.applyUpdate({ version: "0.4.3" })).rejects.toThrow(
      /not newer than the running version/
    );
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });

  test("refuses an explicit version when the running version is not comparable", async () => {
    getCurrentVersionMock.mockReturnValue("nightly");

    await expect(caller.applyUpdate({ version: "1.0.0" })).rejects.toThrow(
      /Cannot compare requested version/
    );
    expect(applyUpdateMock).not.toHaveBeenCalled();
  });

  test("allows an explicit newer version", async () => {
    await expect(caller.applyUpdate({ version: "0.5.0" })).resolves.toEqual({
      targetVersion: "9.9.9",
      restarting: true,
    });
    expect(applyUpdateMock).toHaveBeenCalledWith("0.5.0");
  });

  test("allows a downgrade only when explicitly requested", async () => {
    await expect(
      caller.applyUpdate({ version: "0.1.0", allowDowngrade: true })
    ).resolves.toEqual({ targetVersion: "9.9.9", restarting: true });
    expect(applyUpdateMock).toHaveBeenCalledWith("0.1.0");
  });

  test("leaves the implicit-latest path untouched", async () => {
    await expect(caller.applyUpdate({})).resolves.toEqual({
      targetVersion: "9.9.9",
      restarting: true,
    });
    expect(applyUpdateMock).toHaveBeenCalledWith(undefined);
  });
});
