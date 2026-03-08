import { router } from "./trpc.js";
import { systemRouter } from "../routers/system.js";
import { appsRouter } from "../routers/apps.js";
import { dockerRouter } from "../routers/docker.js";
import { templatesRouter } from "../routers/templates.js";
import { filesRouter } from "../routers/files.js";

export const appRouter = router({
  system: systemRouter,
  apps: appsRouter,
  docker: dockerRouter,
  templates: templatesRouter,
  files: filesRouter,
});

export type AppRouter = typeof appRouter;
