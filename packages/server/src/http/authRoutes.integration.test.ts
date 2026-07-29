import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerAuthRoutes } from "./authRoutes.js";
import {
  crossOriginGuard,
  requireJsonBodyForTrpcWrites,
  securityHeaders,
} from "./securityMiddleware.js";
import {
  resetAuthStateForTests,
  setAuthStoragePathForTests,
} from "../services/auth.js";

const createdDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function createApp() {
  const app = new Hono();
  registerAuthRoutes(app);
  app.get("/api/protected", (c) => c.json({ ok: true }));
  return app;
}

/** Mirrors the middleware registration order used by `src/index.ts`. */
function createHardenedApp() {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.use("*", crossOriginGuard());
  app.use("/api/trpc/*", requireJsonBodyForTrpcWrites());
  registerAuthRoutes(app);
  app.get("/api/protected", (c) => c.json({ ok: true }));
  app.post("/api/files/upload", (c) => c.json({ uploaded: [] }));
  return app;
}

function readSessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) {
    return "";
  }
  return header.split(";")[0] ?? "";
}

describe("authRoutes integration", () => {
  afterEach(async () => {
    resetAuthStateForTests();
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test("configure, unlock, middleware access, change, and disable flow", async () => {
    const root = await createTempDir("deckos-auth-routes-int-");
    setAuthStoragePathForTests(root);
    const app = createApp();

    const configure = await app.request("http://localhost/api/auth/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        passcode: "1234",
        sessionDurationMs: 3_600_000,
      }),
    });
    expect(configure.status).toBe(200);
    expect(await configure.json()).toEqual({
      enabled: true,
      sessionDurationMs: 3_600_000,
    });

    const blocked = await app.request("http://localhost/api/protected");
    expect(blocked.status).toBe(401);
    expect(await blocked.json()).toEqual({ error: "Unauthorized" });

    const unlock = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(unlock.status).toBe(200);
    const cookie = readSessionCookie(unlock);
    expect(cookie).toContain("deckos_session=");

    const allowed = await app.request("http://localhost/api/protected", {
      headers: { Cookie: cookie },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });

    const changed = await app.request("http://localhost/api/auth/change", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        currentPasscode: "1234",
        nextPasscode: "5678",
        sessionDurationMs: 7_200_000,
      }),
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({
      enabled: true,
      sessionDurationMs: 7_200_000,
    });

    const oldPasscodeUnlock = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(oldPasscodeUnlock.status).toBe(401);

    const unlockWithNew = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "5678" }),
    });
    expect(unlockWithNew.status).toBe(200);
    const newCookie = readSessionCookie(unlockWithNew);

    const updatedDuration = await app.request(
      "http://localhost/api/auth/session-duration",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Cookie: newCookie,
        },
        body: JSON.stringify({
          currentPasscode: "5678",
          sessionDurationMs: 10_800_000,
        }),
      }
    );
    expect(updatedDuration.status).toBe(200);
    expect(await updatedDuration.json()).toEqual({
      enabled: true,
      sessionDurationMs: 10_800_000,
    });

    const unlockFinal = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "5678" }),
    });
    const finalCookie = readSessionCookie(unlockFinal);
    const disabled = await app.request("http://localhost/api/auth/disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: finalCookie,
      },
      body: JSON.stringify({
        currentPasscode: "5678",
      }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({
      enabled: false,
      sessionDurationMs: 86_400_000,
    });

    const allowedWhenDisabled = await app.request("http://localhost/api/protected");
    expect(allowedWhenDisabled.status).toBe(200);
    expect(await allowedWhenDisabled.json()).toEqual({ ok: true });
  });

  test("a cross-site page cannot set the passcode on a default install", async () => {
    const root = await createTempDir("deckos-auth-routes-csrf-");
    setAuthStoragePathForTests(root);
    const app = createHardenedApp();

    const attacker = await app.request("http://deckos.lan:3000/api/auth/configure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ passcode: "6666", sessionDurationMs: 3_600_000 }),
    });
    expect(attacker.status).toBe(403);

    // The lock is still off, so the owner has not been locked out.
    const status = await app.request("http://deckos.lan:3000/api/auth/status");
    expect(await status.json()).toMatchObject({ enabled: false, unlocked: true });

    // ...and the owner's own browser can still complete first-time setup.
    const owner = await app.request("http://deckos.lan:3000/api/auth/configure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://deckos.lan:3000",
      },
      body: JSON.stringify({ passcode: "1234", sessionDurationMs: 3_600_000 }),
    });
    expect(owner.status).toBe(200);
  });

  test("a cross-site form cannot reach the upload endpoint", async () => {
    const root = await createTempDir("deckos-auth-routes-upload-");
    setAuthStoragePathForTests(root);
    const app = createHardenedApp();

    const res = await app.request(
      "http://deckos.lan:3000/api/files/upload?path=%2Fetc%2Fsystemd",
      {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "content-type": "multipart/form-data; boundary=x",
        },
        body: "--x--",
      }
    );

    expect(res.status).toBe(403);
  });

  test("responses carry the clickjacking and sniffing headers", async () => {
    const root = await createTempDir("deckos-auth-routes-headers-");
    setAuthStoragePathForTests(root);
    const app = createHardenedApp();

    const res = await app.request("http://deckos.lan:3000/api/auth/status");

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("an unreadable passcode file locks the api instead of opening it", async () => {
    const root = await createTempDir("deckos-auth-routes-corrupt-");
    setAuthStoragePathForTests(root);
    const app = createApp();

    const configure = await app.request("http://localhost/api/auth/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234", sessionDurationMs: 3_600_000 }),
    });
    expect(configure.status).toBe(200);

    const configFile = path.join(root, "security", "passcode.json");
    const raw = await fs.readFile(configFile, "utf8");
    await fs.writeFile(configFile, raw.slice(0, 12), "utf8");
    resetAuthStateForTests();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const blocked = await app.request("http://localhost/api/protected");
    expect(blocked.status).toBe(401);

    const status = await app.request("http://localhost/api/auth/status");
    expect(await status.json()).toMatchObject({ enabled: true, unlocked: false });

    const unlock = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(unlock.status).toBe(503);
    errorSpy.mockRestore();
  });
});
