import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;

/**
 * Every procedure in the app router must be built from this base.
 *
 * There is deliberately no exported unauthenticated procedure: the tRPC handler
 * is mounted ahead of the `/api/*` guard in `authRoutes.ts`, so a procedure
 * built from a bare `t.procedure` would be reachable while the panel is locked.
 * Opting out therefore has to be an explicit edit to this file, and
 * `trpc.test.ts` asserts that every procedure on the app router is built from
 * this base.
 *
 * When the lock is disabled (`ctx.authEnabled === false`) everything is open by
 * design; DeckOS ships with the lock off.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (ctx.authEnabled && !ctx.isAuthenticated) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  }
  return next();
});
