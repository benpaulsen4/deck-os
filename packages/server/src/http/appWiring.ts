import { Hono } from "hono";
import { registerAuthRoutes } from "./authRoutes.js";
import { registerFilesRoutes } from "./filesRoutes.js";
import { registerRuntimeRoutes } from "./runtimeRoutes.js";
import { registerSecurityMiddleware } from "./securityMiddleware.js";

/**
 * Builds the Hono app with every API route and middleware registered in the
 * exact order production uses -- and nothing else. No Docker warm-up, no
 * storage-permission repair, no signal handlers, no listener bind: those are
 * process-lifecycle concerns `index.ts` owns separately, so importing or
 * calling this factory from a test never starts anything.
 *
 * Registration order matters: Hono runs middleware/handlers in the order they
 * are added, so `registerSecurityMiddleware` and `registerAuthRoutes` (which
 * installs the `/api/*` session gate) must be registered before any route
 * they are meant to protect. `index.ts` calls this same function rather than
 * building the app inline, so there is exactly one definition of that order
 * for production and for tests to share (AUTH-9).
 */
export function createServerApp(): Hono {
  const app = new Hono();

  registerSecurityMiddleware(app);
  registerAuthRoutes(app);
  registerRuntimeRoutes(app);
  registerFilesRoutes(app);

  return app;
}
