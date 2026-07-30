import { test, expect, afterAll, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  AuthConfigUnavailableError,
  AuthInvalidPasscodeError,
  AuthRateLimitedError,
  configureAuth,
  disableAuth,
  getAuthStatus,
  getCooldownMsForTests,
  getFailedAttemptKeysForTests,
  isSessionValid,
  resetAuthStateForTests,
  revokeSession,
  setAuthStoragePathForTests,
  unlock,
  updateSessionDuration,
} from "./auth.js";

const isWindows = process.platform === "win32";

async function createTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function configPath(root: string) {
  return path.join(root, "security", "passcode.json");
}

afterEach(() => {
  vi.useRealTimers();
});

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

test("sessions expire once the configured duration has elapsed", async () => {
  const root = await createTempDir("deckos-auth-expiry-");
  setAuthStoragePathForTests(root);
  const sessionDurationMs = 60 * 60 * 1000;
  await configureAuth({ passcode: "2468", sessionDurationMs });

  const session = await unlock({ passcode: "2468", ip: "10.0.0.11" });
  expect(isSessionValid(session.token)).toBe(true);

  vi.useFakeTimers();
  vi.setSystemTime(new Date(session.expiresAt + 1));
  expect(isSessionValid(session.token)).toBe(false);
  expect((await getAuthStatus(session.token)).unlocked).toBe(false);
  vi.useRealTimers();

  await fs.remove(root);
});

test("revokeSession invalidates a live token immediately", async () => {
  const root = await createTempDir("deckos-auth-revoke-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1357", sessionDurationMs: 2 * 60 * 60 * 1000 });

  const session = await unlock({ passcode: "1357", ip: "10.0.0.12" });
  expect(isSessionValid(session.token)).toBe(true);

  revokeSession(session.token);
  expect(isSessionValid(session.token)).toBe(false);
  expect((await getAuthStatus(session.token)).unlocked).toBe(false);
  expect(isSessionValid(null)).toBe(false);

  await fs.remove(root);
});

test("a corrupt passcode file fails closed instead of disabling the lock", async () => {
  const root = await createTempDir("deckos-auth-corrupt-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1234", sessionDurationMs: 2 * 60 * 60 * 1000 });

  const raw = await fs.readFile(configPath(root), "utf8");
  // Simulate the truncation an abrupt exit mid-write used to produce.
  await fs.writeFile(configPath(root), raw.slice(0, Math.floor(raw.length / 2)), "utf8");
  resetAuthStateForTests();

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await getAuthStatus(null);
  expect(status).toEqual({
    enabled: true,
    unlocked: false,
    sessionDurationMs: 24 * 60 * 60 * 1000,
  });
  await expect(unlock({ passcode: "1234", ip: "10.0.0.13" })).rejects.toBeInstanceOf(
    AuthConfigUnavailableError
  );

  // The failure must not be cached: repairing the file recovers without a restart.
  await fs.writeFile(configPath(root), raw, "utf8");
  const recovered = await getAuthStatus(null);
  expect(recovered.enabled).toBe(true);
  const session = await unlock({ passcode: "1234", ip: "10.0.0.13" });
  expect((await getAuthStatus(session.token)).unlocked).toBe(true);
  errorSpy.mockRestore();

  await fs.remove(root);
});

test("a passcode file holding valid JSON that is not an object fails closed", async () => {
  const root = await createTempDir("deckos-auth-nonobject-");
  setAuthStoragePathForTests(root);
  await fs.ensureDir(path.join(root, "security"));
  await fs.writeFile(configPath(root), "null", "utf8");
  resetAuthStateForTests();

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await getAuthStatus(null);
  expect(status.enabled).toBe(true);
  expect(status.unlocked).toBe(false);
  errorSpy.mockRestore();

  await fs.remove(root);
});

test("passcode config is written atomically with restrictive permissions", async () => {
  const root = await createTempDir("deckos-auth-perms-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "9876", sessionDurationMs: 2 * 60 * 60 * 1000 });

  const securityDir = path.join(root, "security");
  const leftovers = (await fs.readdir(securityDir)).filter((name) =>
    name.endsWith(".tmp")
  );
  expect(leftovers).toEqual([]);

  if (!isWindows) {
    expect((await fs.stat(configPath(root))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(securityDir)).mode & 0o777).toBe(0o700);
  }

  await fs.remove(root);
});

test("concurrent unlock attempts cannot outrun the rate limiter", async () => {
  const root = await createTempDir("deckos-auth-concurrent-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1234", sessionDurationMs: 2 * 60 * 60 * 1000 });

  // The passcode hash is awaited, so a client that opens 40 connections at once
  // rather than in series must not get 40 guesses evaluated. Booking the attempt
  // before the await is what makes the check-and-record pair atomic.
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () => unlock({ passcode: "0000", ip: "10.7.0.1" }))
  );

  const evaluated = results.filter(
    (result) =>
      result.status === "rejected" && result.reason instanceof AuthInvalidPasscodeError
  ).length;
  const rateLimited = results.filter(
    (result) =>
      result.status === "rejected" && result.reason instanceof AuthRateLimitedError
  ).length;

  expect(evaluated).toBe(5);
  expect(rateLimited).toBe(35);
  expect(results.some((result) => result.status === "fulfilled")).toBe(false);

  await fs.remove(root);
}, 30_000);

test("a successful unlock does not leave its optimistic failure booked", async () => {
  const root = await createTempDir("deckos-auth-rollback-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "5150", sessionDurationMs: 2 * 60 * 60 * 1000 });

  // Two full rounds of "four near-misses then success". If the attempt booked
  // before hashing were not rolled back, the second round would trip the limiter.
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < 4; index += 1) {
      await expect(unlock({ passcode: "0000", ip: "10.6.0.1" })).rejects.toBeInstanceOf(
        AuthInvalidPasscodeError
      );
    }
    const session = await unlock({ passcode: "5150", ip: "10.6.0.1" });
    expect(session.token).toBeTruthy();
    expect(getCooldownMsForTests("10.6.0.1")).toEqual({ ip: 0, network: 0 });
  }

  await fs.remove(root);
}, 30_000);

test("cooldown escalates across repeated bursts instead of staying flat", async () => {
  const root = await createTempDir("deckos-auth-escalate-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "3344", sessionDurationMs: 2 * 60 * 60 * 1000 });

  vi.useFakeTimers({ toFake: ["Date"] });
  // Evicting a record as soon as its cooldown lapses would discard the
  // escalation level and flatten this to 5/5/5.
  for (const expectedMinutes of [5, 10, 20]) {
    for (let index = 0; index < 5; index += 1) {
      await expect(unlock({ passcode: "0000", ip: "10.8.0.1" })).rejects.toBeInstanceOf(
        AuthInvalidPasscodeError
      );
    }
    expect(getCooldownMsForTests("10.8.0.1").ip).toBe(expectedMinutes * 60 * 1000);
    vi.setSystemTime(new Date(Date.now() + expectedMinutes * 60 * 1000 + 1_000));
  }
  vi.useRealTimers();

  await fs.remove(root);
}, 30_000);

test("failed-attempt records are evicted only after genuine inactivity", async () => {
  const root = await createTempDir("deckos-auth-prune-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "3344", sessionDurationMs: 2 * 60 * 60 * 1000 });

  for (let index = 0; index < 5; index += 1) {
    await expect(unlock({ passcode: "0000", ip: "10.8.0.1" })).rejects.toBeInstanceOf(
      AuthInvalidPasscodeError
    );
  }
  expect(getFailedAttemptKeysForTests().ips).toContain("10.8.0.1");

  vi.useFakeTimers({ toFake: ["Date"] });
  // Past the cooldown but still recent: the record must survive, or escalation
  // is lost.
  vi.setSystemTime(new Date(Date.now() + 20 * 60 * 1000));
  await expect(unlock({ passcode: "0000", ip: "172.16.0.1" })).rejects.toBeInstanceOf(
    AuthInvalidPasscodeError
  );
  expect(getFailedAttemptKeysForTests().ips).toContain("10.8.0.1");

  // Past the window plus the longest cooldown with no further attempts: evicted,
  // so the maps cannot grow without bound.
  vi.setSystemTime(new Date(Date.now() + 45 * 60 * 1000));
  const session = await unlock({ passcode: "3344", ip: "172.16.0.1" });
  expect(session.token).toBeTruthy();
  const keys = getFailedAttemptKeysForTests();
  expect(keys.ips).not.toContain("10.8.0.1");
  expect(keys.networks).not.toContain("10.8.0.0/24");
  vi.useRealTimers();

  await fs.remove(root);
}, 30_000);

test("unlock enforces a shared cooldown across one client network", async () => {
  const root = await createTempDir("deckos-auth-network-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1122", sessionDurationMs: 2 * 60 * 60 * 1000 });

  // 20 failures spread over 20 addresses in one /24: each address stays under the
  // per-IP limit of 5, so only the network limiter can catch this.
  for (let index = 0; index < 20; index += 1) {
    await expect(
      unlock({ passcode: "0000", ip: `10.9.0.${index}` })
    ).rejects.toBeInstanceOf(AuthInvalidPasscodeError);
  }

  await expect(unlock({ passcode: "1122", ip: "10.9.0.99" })).rejects.toBeInstanceOf(
    AuthRateLimitedError
  );

  await fs.remove(root);
}, 30_000);

test("one network's cooldown does not lock out a different network", async () => {
  const root = await createTempDir("deckos-auth-network-scope-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1122", sessionDurationMs: 2 * 60 * 60 * 1000 });

  for (let index = 0; index < 20; index += 1) {
    await expect(
      unlock({ passcode: "0000", ip: `10.9.0.${index}` })
    ).rejects.toBeInstanceOf(AuthInvalidPasscodeError);
  }
  expect(getCooldownMsForTests("10.9.0.1").network).toBeGreaterThan(0);

  // The limiter is scoped to a /24 rather than being truly global precisely so
  // one hostile subnet cannot lock out everybody else.
  const session = await unlock({ passcode: "1122", ip: "192.168.4.10" });
  expect(session.token).toBeTruthy();

  await fs.remove(root);
}, 30_000);

test("addresses in one IPv6 /64 share a bucket", async () => {
  const root = await createTempDir("deckos-auth-v6-");
  setAuthStoragePathForTests(root);
  await configureAuth({ passcode: "1122", sessionDurationMs: 2 * 60 * 60 * 1000 });

  // A single host owns an entire /64, so cycling addresses inside it must not
  // buy extra guesses.
  for (let index = 0; index < 20; index += 1) {
    await expect(
      unlock({ passcode: "0000", ip: `2001:db8:1:2::${index + 1}` })
    ).rejects.toBeInstanceOf(AuthInvalidPasscodeError);
  }

  await expect(
    unlock({ passcode: "1122", ip: "2001:db8:1:2::ffff" })
  ).rejects.toBeInstanceOf(AuthRateLimitedError);

  // A different /64 is a different client.
  const session = await unlock({ passcode: "1122", ip: "2001:db8:1:3::1" });
  expect(session.token).toBeTruthy();

  await fs.remove(root);
}, 30_000);

afterAll(() => {
  resetAuthStateForTests();
});
