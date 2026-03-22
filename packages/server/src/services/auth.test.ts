import { test, expect, afterAll } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  AuthInvalidPasscodeError,
  AuthRateLimitedError,
  configureAuth,
  disableAuth,
  getAuthStatus,
  resetAuthStateForTests,
  setAuthStoragePathForTests,
  unlock,
  updateSessionDuration,
} from "./auth.js";

async function createTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("auth defaults to disabled and unlock is not required", async () => {
  const root = await createTempDir("deckos-auth-default-");
  setAuthStoragePathForTests(root);
  const status = await getAuthStatus(null);
  expect(status.enabled).toBe(false);
  expect(status.unlocked).toBe(true);
  await fs.remove(root);
});

test("configureAuth enables auth and unlock accepts correct passcode", async () => {
  const root = await createTempDir("deckos-auth-configure-");
  setAuthStoragePathForTests(root);
  await configureAuth({
    passcode: "1234",
    sessionDurationMs: 2 * 60 * 60 * 1000,
  });

  const lockedStatus = await getAuthStatus(null);
  expect(lockedStatus.enabled).toBe(true);
  expect(lockedStatus.unlocked).toBe(false);

  const unlocked = await unlock({ passcode: "1234", ip: "10.0.0.5" });
  const unlockedStatus = await getAuthStatus(unlocked.token);
  expect(unlockedStatus.enabled).toBe(true);
  expect(unlockedStatus.unlocked).toBe(true);
  await fs.remove(root);
});

test("unlock enforces per-IP cooldown after repeated failures", async () => {
  const root = await createTempDir("deckos-auth-limit-");
  setAuthStoragePathForTests(root);
  await configureAuth({
    passcode: "5678",
    sessionDurationMs: 2 * 60 * 60 * 1000,
  });

  for (let index = 0; index < 5; index += 1) {
    await expect(unlock({ passcode: "0000", ip: "10.0.0.9" })).rejects.toBeInstanceOf(
      AuthInvalidPasscodeError
    );
  }

  await expect(unlock({ passcode: "5678", ip: "10.0.0.9" })).rejects.toBeInstanceOf(
    AuthRateLimitedError
  );
  await fs.remove(root);
});

test("updateSessionDuration and disableAuth require the current passcode", async () => {
  const root = await createTempDir("deckos-auth-current-");
  setAuthStoragePathForTests(root);
  await configureAuth({
    passcode: "4321",
    sessionDurationMs: 2 * 60 * 60 * 1000,
  });

  await expect(
    updateSessionDuration({
      currentPasscode: "9999",
      sessionDurationMs: 3 * 60 * 60 * 1000,
    })
  ).rejects.toBeInstanceOf(AuthInvalidPasscodeError);
  await expect(disableAuth("9999")).rejects.toBeInstanceOf(AuthInvalidPasscodeError);

  await disableAuth("4321");
  const status = await getAuthStatus(null);
  expect(status.enabled).toBe(false);
  expect(status.unlocked).toBe(true);
  await fs.remove(root);
});

afterAll(() => {
  resetAuthStateForTests();
});
