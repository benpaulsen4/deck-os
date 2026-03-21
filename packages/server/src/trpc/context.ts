import type { Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";
import * as authService from "../services/auth.js";

export type Context = {
  authEnabled: boolean;
  isAuthenticated: boolean;
  sessionToken: string | null;
  clientIp: string;
};

function getClientIp(c: HonoContext): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = c.req.header("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}

export async function createContext(c: HonoContext): Promise<Context> {
  const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
  const status = await authService.getAuthStatus(sessionToken);
  return {
    authEnabled: status.enabled,
    isAuthenticated: status.unlocked,
    sessionToken,
    clientIp: getClientIp(c),
  };
}
