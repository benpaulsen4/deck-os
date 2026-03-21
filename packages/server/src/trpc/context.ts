import type { Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";
import * as authService from "../services/auth.js";
import { getDirectClientIp } from "../lib/clientIp.js";

export type Context = {
  authEnabled: boolean;
  isAuthenticated: boolean;
  sessionToken: string | null;
  clientIp: string;
};

export async function createContext(c: HonoContext): Promise<Context> {
  const sessionToken = getCookie(c, authService.getAuthCookieName()) ?? null;
  const status = await authService.getAuthStatus(sessionToken);
  return {
    authEnabled: status.enabled,
    isAuthenticated: status.unlocked,
    sessionToken,
    clientIp: getDirectClientIp(c),
  };
}
