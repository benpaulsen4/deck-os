import { router } from "./trpc.js";
import { systemRouter } from "../routers/system.js";
import { appsRouter } from "../routers/apps.js";
import { dockerRouter } from "../routers/docker.js";

export const appRouter = router({
  system: systemRouter,
  apps: appsRouter,
  docker: dockerRouter,
});

export type AppRouter = typeof appRouter;
