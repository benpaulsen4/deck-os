import test from "node:test";
import assert from "node:assert/strict";
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "sudo");
  assert.deepEqual(calls[0].args, ["-n", "/usr/bin/systemctl", "poweroff"]);
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

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "sudo");
  assert.equal(calls[1].command, "/usr/bin/systemctl");
  assert.deepEqual(calls[1].args, ["reboot"]);
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

  await assert.rejects(
    runPowerAction("shutdown", {
      spawnImpl: spawnStub,
      platform: "linux",
      uid: 1001,
    }),
    /Unable to execute shutdown command/
  );
  assert.ok(calls.length >= 2);
});
