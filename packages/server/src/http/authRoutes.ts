import type { Context as HonoContext, Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { appRouter } from "../trpc/router.js";
import { createContext } from "../trpc/context.js";
import * as authService from "../services/auth.js";
import { getDirectClientIp } from "../lib/clientIp.js";

/**
 * `x-forwarded-proto` is attacker-controlled unless a trusted proxy is known to
 * set it: a client that sends it over plain HTTP would be issued a `Secure`
 * cookie the browser refuses to store, producing an unlock that returns 200 and
 * then 401s forever. This mirrors the no-trust stance `lib/clientIp.ts` already
 * takes for client addresses; set `DECKOS_TRUST_PROXY=1` when DeckOS really is
 * behind a TLS-terminating reverse proxy.
 */
function trustsProxyHeaders(): boolean {
  const value = process.env.DECKOS_TRUST_PROXY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isHttpsRequest(url: string, forwardedProto?: string): boolean {
  if (trustsProxyHeaders() && forwardedProto?.toLowerCase().startsWith("https")) {
    return true;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A cross-site HTML form can only send `application/x-www-form-urlencoded`,
 * `multipart/form-data` or `text/plain`, and `c.req.json()` happily parses a
 * `text/plain` body. Requiring a JSON content-type on the auth writes closes
 * that path independently of the origin check; the SPA already sends it.
 */
function requireJsonRequest(c: HonoContext): boolean {
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
  return contentType?.toLowerCase() === "application/json";
}

function unsupportedMediaType(c: HonoContext) {
  return c.json({ error: "Content-Type must be application/json" }, 415);
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
    if (!requireJsonRequest(c)) {
      return unsupportedMediaType(c);
    }
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
      if (error instanceof authService.AuthConfigUnavailableError) {
        return c.json({ error: error.message }, 503);
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
    // Intentionally reachable without a session: on a default install there is
    // no passcode yet, so first-time setup has to be possible. It is *not*
    // restricted to loopback -- DeckOS is designed to be set up from another
    // machine on the LAN. Cross-site abuse is blocked by `crossOriginGuard`
    // plus the JSON content-type requirement below.
    if (!requireJsonRequest(c)) {
      return unsupportedMediaType(c);
    }
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
      if (error instanceof authService.AuthConfigUnavailableError) {
        return c.json({ error: error.message }, 503);
      }
      return c.json(
        { error: error instanceof Error ? error.message : "Configure failed" },
        500
      );
    }
  });

  app.post("/api/auth/change", async (c) => {
    if (!requireJsonRequest(c)) {
      return unsupportedMediaType(c);
    }
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
      if (error instanceof authService.AuthConfigUnavailableError) {
        return c.json({ error: error.message }, 503);
      }
      return c.json({ error: "Passcode update failed" }, 500);
    }
  });

  app.post("/api/auth/session-duration", async (c) => {
    if (!requireJsonRequest(c)) {
      return unsupportedMediaType(c);
    }
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
      if (error instanceof authService.AuthConfigUnavailableError) {
        return c.json({ error: error.message }, 503);
      }
      return c.json({ error: "Session duration update failed" }, 500);
    }
  });

  app.post("/api/auth/disable", async (c) => {
    if (!requireJsonRequest(c)) {
      return unsupportedMediaType(c);
    }
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
      if (error instanceof authService.AuthConfigUnavailableError) {
        return c.json({ error: error.message }, 503);
      }
      return c.json({ error: "Disable auth failed" }, 500);
    }
  });
}
