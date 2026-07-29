import { describe, expect, test } from "vitest";
import { TRPCError } from "@trpc/server";
import type { Context } from "./context.js";
import { protectedProcedure, router } from "./trpc.js";
import { appRouter } from "./router.js";

function context(overrides: Partial<Context> = {}): Context {
  return {
    authEnabled: false,
    isAuthenticated: false,
    sessionToken: null,
    clientIp: "10.0.0.4",
    ...overrides,
  };
}

const probeRouter = router({
  ping: protectedProcedure.query(() => "pong"),
});

describe("protectedProcedure", () => {
  test("rejects with UNAUTHORIZED when the lock is on and the caller is locked", async () => {
    const caller = probeRouter.createCaller(
      context({ authEnabled: true, isAuthenticated: false })
    );

    await expect(caller.ping()).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.ping()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("passes when the lock is on and the session is unlocked", async () => {
    const caller = probeRouter.createCaller(
      context({ authEnabled: true, isAuthenticated: true, sessionToken: "token" })
    );

    await expect(caller.ping()).resolves.toBe("pong");
  });

  test("passes when the lock is off, which is the documented default", async () => {
    const caller = probeRouter.createCaller(
      context({ authEnabled: false, isAuthenticated: false })
    );

    await expect(caller.ping()).resolves.toBe("pong");
  });
});

describe("app router", () => {
  // The tRPC handler is mounted ahead of the `/api/*` guard, so a procedure that
  // is not built from `protectedProcedure` would be reachable while the panel is
  // locked. This asserts the whole surface, not the procedures we remembered.
  test("every procedure is built from protectedProcedure", () => {
    const authGuard = (
      protectedProcedure as unknown as { _def: { middlewares: unknown[] } }
    )._def.middlewares[0];
    expect(authGuard).toBeTypeOf("function");

    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, { _def: { middlewares: unknown[] } }> };
      }
    )._def.procedures;

    const entries = Object.entries(procedures);
    expect(entries.length).toBeGreaterThan(0);

    const unguarded = entries
      .filter(([, procedure]) => procedure._def.middlewares[0] !== authGuard)
      .map(([path]) => path);
    expect(unguarded).toEqual([]);
  });
});
