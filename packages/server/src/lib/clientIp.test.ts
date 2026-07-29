import { test, expect } from "vitest";
import type { Context as HonoContext } from "hono";
import { getDirectClientIp } from "./clientIp.js";

function contextWithRemote(
  remoteAddress?: string,
  headers: Record<string, string> = {}
): HonoContext {
  return {
    env: {
      incoming: {
        socket: {
          remoteAddress,
        },
        headers,
      },
    },
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      raw: { headers: new Headers(headers) },
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

test("getDirectClientIp ignores spoofable proxy headers", () => {
  const spoofed = {
    "x-forwarded-for": "1.2.3.4",
    "x-real-ip": "5.6.7.8",
    forwarded: "for=9.9.9.9",
  };

  // A client that invents these headers must not be able to move itself off the
  // per-IP unlock rate limiter.
  expect(getDirectClientIp(contextWithRemote("192.168.1.25", spoofed))).toBe(
    "192.168.1.25"
  );
  expect(getDirectClientIp(contextWithRemote(undefined, spoofed))).toBe("unknown");
});
