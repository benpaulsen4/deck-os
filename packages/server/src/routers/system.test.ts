import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { runPowerAction } from "./system.js";

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
