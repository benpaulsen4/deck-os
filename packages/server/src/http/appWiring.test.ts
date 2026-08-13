import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as authService from "../services/auth.js";
import { DATA_DIR } from "../lib/config.js";
import { createServerApp } from "./appWiring.js";

/**
 * `runtimeRoutes.test.ts`'s own `createApp()` helper only calls
 * `registerRuntimeRoutes` -- it never registers `registerAuthRoutes`, which is
 * what installs the `/api/*` session gate. So whether `/api/logs/:id`,
 * `/api/files/download` and `/api/metrics/stream` actually require a session
 * depends entirely on registration order in `index.ts` (auth middleware must
 * be registered before the routes it protects), and nothing exercises that
 * order. Reorder those three lines in production and container logs plus
 * arbitrary file download go public -- with the whole suite still green.
 *
 * `createServerApp()` is the same factory `index.ts` calls to build its real
 * app, so building it here and hitting it directly proves the production
 * wiring, not a parallel test-only order.
 */
describe("createServerApp auth-middleware registration order (AUTH-9)", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    // Restores the storage path to production's default (this also resets
    // in-memory auth state) so a later test never inherits a path pointing at
    // a temp dir this block has already removed.
    authService.setAuthStoragePathForTests(DATA_DIR);
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  async function lockPanel(passcode: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-appwiring-"));
    createdDirs.push(root);
    authService.setAuthStoragePathForTests(root);
    await authService.configureAuth({ passcode, sessionDurationMs: 3_600_000 });
  }

  test.each([
    "/api/logs/abc123",
    "/api/files/download?path=/etc/passwd",
    "/api/metrics/stream",
  ])("%s requires a session when the panel is locked", async (route) => {
    await lockPanel("123456");
    const app = createServerApp();

    const response = await app.request(route);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("a valid session reaches the route past the same middleware chain", async () => {
    await lockPanel("123456");
    const { token } = await authService.unlock({ passcode: "123456", ip: "127.0.0.1" });
    const app = createServerApp();

    const response = await app.request("/api/files/download?path=/etc/passwd", {
      headers: { cookie: `deckos_session=${token}` },
    });

    // Not 401: the request reached filesRoutes' own handler, which fails for
    // an unrelated reason (no such file inside the allowed root). A change
    // that broke access for everyone -- not just reordered the auth gate --
    // would still pass the three locked-panel assertions above but fail this
    // one.
    expect(response.status).not.toBe(401);
  });
});
