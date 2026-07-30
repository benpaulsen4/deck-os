import { beforeEach, expect, test, vi } from "vitest";
import type { Context as HonoContext } from "hono";

const authMock = vi.hoisted(() => ({
  getAuthCookieName: vi.fn(() => "deckos_session"),
  getAuthStatus: vi.fn(),
}));

const clientIpMock = vi.hoisted(() => ({
  getDirectClientIp: vi.fn(() => "192.168.0.7"),
}));

vi.mock("../services/auth.js", () => authMock);
vi.mock("../lib/clientIp.js", () => clientIpMock);

import { createContext } from "./context.js";

function honoContext(cookieHeader?: string): HonoContext {
  const headers = new Headers();
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  return {
    req: {
      raw: { headers },
      header: (name: string) => headers.get(name) ?? undefined,
    },
  } as unknown as HonoContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getAuthCookieName.mockReturnValue("deckos_session");
  clientIpMock.getDirectClientIp.mockReturnValue("192.168.0.7");
});

test("createContext reports an unlocked session from the cookie", async () => {
  authMock.getAuthStatus.mockResolvedValue({
    enabled: true,
    unlocked: true,
    sessionDurationMs: 3_600_000,
  });

  const ctx = await createContext(honoContext("deckos_session=session-token"));

  expect(authMock.getAuthStatus).toHaveBeenCalledWith("session-token");
  expect(ctx).toEqual({
    authEnabled: true,
    isAuthenticated: true,
    sessionToken: "session-token",
    clientIp: "192.168.0.7",
  });
});

test("createContext reports a locked session when the cookie is absent", async () => {
  authMock.getAuthStatus.mockResolvedValue({
    enabled: true,
    unlocked: false,
    sessionDurationMs: 3_600_000,
  });

  const ctx = await createContext(honoContext());

  expect(authMock.getAuthStatus).toHaveBeenCalledWith(null);
  expect(ctx.authEnabled).toBe(true);
  expect(ctx.isAuthenticated).toBe(false);
  expect(ctx.sessionToken).toBeNull();
});

test("createContext leaves everything open when the lock is disabled", async () => {
  authMock.getAuthStatus.mockResolvedValue({
    enabled: false,
    unlocked: true,
    sessionDurationMs: 86_400_000,
  });

  const ctx = await createContext(honoContext());

  expect(ctx.authEnabled).toBe(false);
  expect(ctx.isAuthenticated).toBe(true);
});

test("createContext takes the client ip from the direct socket address", async () => {
  authMock.getAuthStatus.mockResolvedValue({
    enabled: false,
    unlocked: true,
    sessionDurationMs: 86_400_000,
  });
  clientIpMock.getDirectClientIp.mockReturnValue("10.2.3.4");

  const ctx = await createContext(honoContext());

  expect(ctx.clientIp).toBe("10.2.3.4");
});
