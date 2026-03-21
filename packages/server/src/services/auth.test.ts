import test, { after } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(status.enabled, false);
  assert.equal(status.unlocked, true);
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
  assert.equal(lockedStatus.enabled, true);
  assert.equal(lockedStatus.unlocked, false);

  const unlocked = await unlock({ passcode: "1234", ip: "10.0.0.5" });
  const unlockedStatus = await getAuthStatus(unlocked.token);
  assert.equal(unlockedStatus.enabled, true);
  assert.equal(unlockedStatus.unlocked, true);
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
    await assert.rejects(unlock({ passcode: "0000", ip: "10.0.0.9" }), AuthInvalidPasscodeError);
  }

  await assert.rejects(
    unlock({ passcode: "5678", ip: "10.0.0.9" }),
    (error: unknown) => error instanceof AuthRateLimitedError
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

  await assert.rejects(
    updateSessionDuration({
      currentPasscode: "9999",
      sessionDurationMs: 3 * 60 * 60 * 1000,
    }),
    AuthInvalidPasscodeError
  );
  await assert.rejects(disableAuth("9999"), AuthInvalidPasscodeError);

  await disableAuth("4321");
  const status = await getAuthStatus(null);
  assert.equal(status.enabled, false);
  assert.equal(status.unlocked, true);
  await fs.remove(root);
});

after(() => {
  resetAuthStateForTests();
});
