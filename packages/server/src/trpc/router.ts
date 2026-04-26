import { router } from "./trpc.js";
import { systemRouter } from "../routers/system.js";
import { appsRouter } from "../routers/apps.js";
import { dockerRouter } from "../routers/docker.js";
import { templatesRouter } from "../routers/templates.js";
import { filesRouter } from "../routers/files.js";
import { storageRouter } from "../routers/storage.js";

export const appRouter = router({
  system: systemRouter,
  apps: appsRouter,
  docker: dockerRouter,
  templates: templatesRouter,
  files: filesRouter,
  storage: storageRouter,
});

export type AppRouter = typeof appRouter;
