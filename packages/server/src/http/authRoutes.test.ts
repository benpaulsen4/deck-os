import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

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

  return {
    AuthRateLimitedError,
    AuthInvalidPasscodeError,
    AuthNotEnabledError,
    AuthValidationError,
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

describe("authRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.getAuthCookieName.mockReturnValue("deckos_session");
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
