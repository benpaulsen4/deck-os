import { test, expect } from "vitest";
import type { Context as HonoContext } from "hono";
import { getDirectClientIp } from "./clientIp.js";

function contextWithRemote(remoteAddress?: string): HonoContext {
  return {
    env: {
      incoming: {
        socket: {
          remoteAddress,
        },
      },
    },
  } as unknown as HonoContext;
}

test("getDirectClientIp reads direct remote address", () => {
  const ip = getDirectClientIp(contextWithRemote("192.168.1.25"));
  expect(ip).toBe("192.168.1.25");
});

test("getDirectClientIp normalizes ipv6 mapped ipv4", () => {
  const ip = getDirectClientIp(contextWithRemote("::ffff:10.0.0.9"));
  expect(ip).toBe("10.0.0.9");
});

test("getDirectClientIp returns unknown for missing address", () => {
  const ip = getDirectClientIp(contextWithRemote(undefined));
  expect(ip).toBe("unknown");
});
