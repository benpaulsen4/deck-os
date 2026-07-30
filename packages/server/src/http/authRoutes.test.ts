import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const authMock = vi.hoisted(() => {
  class AuthRateLimitedError extends Error {
    retryAfterMs: number;
    constructor(retryAfterMs: number) {
      super("Too many failed attempts. Please try again later.");
      this.name = "AuthRateLimitedError";
      this.retryAfterMs = retryAfterMs;
    }
  }
  class AuthInvalidPasscodeError extends Error {
    constructor() {
      super("Invalid passcode.");
      this.name = "AuthInvalidPasscodeError";
    }
  }
  class AuthNotEnabledError extends Error {
    constructor() {
      super("Passcode authentication is not enabled.");
      this.name = "AuthNotEnabledError";
    }
  }
  class AuthValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AuthValidationError";
    }
  }
  class AuthConfigUnavailableError extends Error {
    constructor() {
      super("Passcode configuration could not be read.");
      this.name = "AuthConfigUnavailableError";
    }
  }

  return {
    AuthRateLimitedError,
    AuthInvalidPasscodeError,
    AuthNotEnabledError,
    AuthValidationError,
    AuthConfigUnavailableError,
    getAuthCookieName: vi.fn(() => "deckos_session"),
    getAuthStatus: vi.fn(),
    unlock: vi.fn(),
    revokeSession: vi.fn(),
    configureAuth: vi.fn(),
    changePasscode: vi.fn(),
    updateSessionDuration: vi.fn(),
    disableAuth: vi.fn(),
  };
});

const clientIpMock = vi.hoisted(() => ({
  getDirectClientIp: vi.fn(() => "10.1.2.3"),
}));

vi.mock("../services/auth.js", () => authMock);
vi.mock("../lib/clientIp.js", () => clientIpMock);

import { registerAuthRoutes } from "./authRoutes.js";

function createApp() {
  const app = new Hono();
  registerAuthRoutes(app);
  return app;
}

const ORIGINAL_TRUST_PROXY = process.env.DECKOS_TRUST_PROXY;

describe("authRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getAuthCookieName.mockReturnValue("deckos_session");
    delete process.env.DECKOS_TRUST_PROXY;
  });

  afterEach(() => {
    if (ORIGINAL_TRUST_PROXY === undefined) {
      delete process.env.DECKOS_TRUST_PROXY;
    } else {
      process.env.DECKOS_TRUST_PROXY = ORIGINAL_TRUST_PROXY;
    }
  });

  test("blocks protected api paths when session is locked", async () => {
    authMock.getAuthStatus.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 3_600_000,
      expiresAt: null,
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/protected");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(authMock.getAuthStatus).toHaveBeenCalledWith(null);
  });

  test("returns auth status for current session cookie", async () => {
    authMock.getAuthStatus.mockResolvedValue({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 3_600_000,
      expiresAt: Date.now() + 3_600_000,
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/auth/status", {
      headers: {
        Cookie: "deckos_session=session-token",
      },
    });

    expect(res.status).toBe(200);
    expect(authMock.getAuthStatus).toHaveBeenCalledWith("session-token");
    expect(await res.json()).toEqual({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 3_600_000,
      expiresAt: expect.any(Number),
    });
  });

  test("unlock sets httpOnly cookie on success", async () => {
    authMock.unlock.mockResolvedValue({
      token: "abc123",
      sessionDurationMs: 3_600_000,
      expiresAt: Date.now() + 3_600_000,
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });

    expect(res.status).toBe(200);
    expect(authMock.unlock).toHaveBeenCalledWith({ passcode: "1234", ip: "10.1.2.3" });
    expect(await res.json()).toEqual({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 3_600_000,
      expiresAt: expect.any(Number),
    });
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("deckos_session=abc123");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  test("unlock returns 429 for rate limit errors", async () => {
    authMock.unlock.mockRejectedValue(new authMock.AuthRateLimitedError(12_000));
    const app = createApp();

    const res = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many failed attempts. Please try again later.",
      retryAfterMs: 12_000,
    });
  });

  test("unlock ignores x-forwarded-proto unless DECKOS_TRUST_PROXY is set", async () => {
    authMock.unlock.mockResolvedValue({
      token: "abc123",
      sessionDurationMs: 3_600_000,
      expiresAt: Date.now() + 3_600_000,
    });
    const app = createApp();

    // Without the flag a spoofed header must not produce a `Secure` cookie the
    // browser would then refuse to store over plain HTTP.
    const res = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(res.headers.get("set-cookie")).not.toContain("Secure");

    process.env.DECKOS_TRUST_PROXY = "1";
    const trusted = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ passcode: "1234" }),
    });
    expect(trusted.headers.get("set-cookie")).toContain("Secure");
  });

  test("unlock always marks the cookie Secure over real https", async () => {
    authMock.unlock.mockResolvedValue({
      token: "abc123",
      sessionDurationMs: 3_600_000,
      expiresAt: Date.now() + 3_600_000,
    });
    const app = createApp();

    const res = await app.request("https://deckos.lan/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });

    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test.each([
    "/api/auth/unlock",
    "/api/auth/configure",
    "/api/auth/change",
    "/api/auth/session-duration",
    "/api/auth/disable",
  ])("%s rejects non-JSON bodies a cross-site form could send", async (path) => {
    authMock.getAuthStatus.mockResolvedValue({
      enabled: true,
      unlocked: true,
      sessionDurationMs: 3_600_000,
    });
    const app = createApp();

    const res = await app.request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ passcode: "9999", sessionDurationMs: 3_600_000 }),
    });

    expect(res.status).toBe(415);
    expect(authMock.configureAuth).not.toHaveBeenCalled();
    expect(authMock.unlock).not.toHaveBeenCalled();
  });

  test("unlock reports an unreadable passcode config as 503", async () => {
    authMock.unlock.mockRejectedValue(new authMock.AuthConfigUnavailableError());
    const app = createApp();

    const res = await app.request("http://localhost/api/auth/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "1234" }),
    });

    expect(res.status).toBe(503);
  });

  test("change endpoint requires an unlocked session", async () => {
    authMock.getAuthStatus.mockResolvedValue({
      enabled: true,
      unlocked: false,
      sessionDurationMs: 3_600_000,
      expiresAt: null,
    });
    const app = createApp();

    const res = await app.request("http://localhost/api/auth/change", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPasscode: "1111",
        nextPasscode: "2222",
        sessionDurationMs: 3_600_000,
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});
