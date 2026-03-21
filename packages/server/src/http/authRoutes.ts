import type { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { appRouter } from "../trpc/router.js";
import { createContext } from "../trpc/context.js";
import * as authService from "../services/auth.js";
import { getDirectClientIp } from "../lib/clientIp.js";

function isHttpsRequest(url: string, forwardedProto?: string): boolean {
  if (forwardedProto?.toLowerCase().startsWith("https")) {
    return true;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function getSessionToken(c: Parameters<typeof getCookie>[0]) {
  return getCookie(c, authService.getAuthCookieName()) ?? null;
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  sessionToken: string,
  sessionDurationMs: number
) {
  setCookie(c, authService.getAuthCookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttpsRequest(c.req.url, c.req.header("x-forwarded-proto")),
    path: "/",
    maxAge: Math.floor(sessionDurationMs / 1000),
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, authService.getAuthCookieName(), {
    path: "/",
  });
}

export function registerAuthRoutes(app: Hono) {
  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      createContext: (_opts, c) => createContext(c),
    })
  );

  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api/health" || path.startsWith("/api/auth/")) {
      await next();
      return;
    }
    const sessionToken = getSessionToken(c);
    const status = await authService.getAuthStatus(sessionToken);
    if (!status.unlocked) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/auth/status", async (c) => {
    const status = await authService.getAuthStatus(getSessionToken(c));
    return c.json(status);
  });

  app.post("/api/auth/unlock", async (c) => {
    const body = await c.req.json().catch(() => null);
    const passcode = typeof body?.passcode === "string" ? body.passcode : "";
    const ip = getDirectClientIp(c);
    try {
      const result = await authService.unlock({ passcode, ip });
      setSessionCookie(c, result.token, result.sessionDurationMs);
      return c.json({
        enabled: true,
        unlocked: true,
        sessionDurationMs: result.sessionDurationMs,
        expiresAt: result.expiresAt,
      });
    } catch (error: unknown) {
      if (error instanceof authService.AuthRateLimitedError) {
        return c.json({ error: error.message, retryAfterMs: error.retryAfterMs }, 429);
      }
      if (error instanceof authService.AuthInvalidPasscodeError) {
        return c.json({ error: error.message }, 401);
      }
      if (
        error instanceof authService.AuthNotEnabledError ||
        error instanceof authService.AuthValidationError
      ) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Unlock failed" }, 500);
    }
  });

  app.post("/api/auth/lock", async (c) => {
    authService.revokeSession(getSessionToken(c));
    clearSessionCookie(c);
    const status = await authService.getAuthStatus(null);
    return c.json(status);
  });

  app.post("/api/auth/configure", async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      const result = await authService.configureAuth({
        passcode: typeof body?.passcode === "string" ? body.passcode : "",
        sessionDurationMs: Number(body?.sessionDurationMs),
      });
      return c.json(result);
    } catch (error: unknown) {
      if (error instanceof authService.AuthValidationError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json(
        { error: error instanceof Error ? error.message : "Configure failed" },
        500
      );
    }
  });

  app.post("/api/auth/change", async (c) => {
    const sessionToken = getSessionToken(c);
    const status = await authService.getAuthStatus(sessionToken);
    if (!status.unlocked) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    try {
      const result = await authService.changePasscode({
        currentPasscode:
          typeof body?.currentPasscode === "string" ? body.currentPasscode : "",
        nextPasscode: typeof body?.nextPasscode === "string" ? body.nextPasscode : "",
        sessionDurationMs:
          body?.sessionDurationMs === undefined
            ? undefined
            : Number(body.sessionDurationMs),
      });
      authService.revokeSession(sessionToken);
      clearSessionCookie(c);
      return c.json(result);
    } catch (error: unknown) {
      if (error instanceof authService.AuthInvalidPasscodeError) {
        return c.json({ error: error.message }, 401);
      }
      if (
        error instanceof authService.AuthValidationError ||
        error instanceof authService.AuthNotEnabledError
      ) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Passcode update failed" }, 500);
    }
  });

  app.post("/api/auth/session-duration", async (c) => {
    const sessionToken = getSessionToken(c);
    const status = await authService.getAuthStatus(sessionToken);
    if (!status.unlocked) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    try {
      const result = await authService.updateSessionDuration({
        currentPasscode:
          typeof body?.currentPasscode === "string" ? body.currentPasscode : "",
        sessionDurationMs: Number(body?.sessionDurationMs),
      });
      authService.revokeSession(sessionToken);
      clearSessionCookie(c);
      return c.json(result);
    } catch (error: unknown) {
      if (error instanceof authService.AuthInvalidPasscodeError) {
        return c.json({ error: error.message }, 401);
      }
      if (
        error instanceof authService.AuthValidationError ||
        error instanceof authService.AuthNotEnabledError
      ) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Session duration update failed" }, 500);
    }
  });

  app.post("/api/auth/disable", async (c) => {
    const sessionToken = getSessionToken(c);
    const status = await authService.getAuthStatus(sessionToken);
    if (!status.unlocked) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    try {
      const result = await authService.disableAuth(
        typeof body?.currentPasscode === "string" ? body.currentPasscode : ""
      );
      authService.revokeSession(sessionToken);
      clearSessionCookie(c);
      return c.json(result);
    } catch (error: unknown) {
      if (error instanceof authService.AuthInvalidPasscodeError) {
        return c.json({ error: error.message }, 401);
      }
      if (
        error instanceof authService.AuthValidationError ||
        error instanceof authService.AuthNotEnabledError
      ) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "Disable auth failed" }, 500);
    }
  });
}
