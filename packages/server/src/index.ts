import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import * as dockerService from "./services/docker.js";
import { ensureAuthStoragePermissions } from "./services/auth.js";
import { pruneDiskAnalysisCache } from "./services/diskAnalysis.js";
import { createServerApp } from "./http/appWiring.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dockerService.getDocker();

// Tighten permissions on a pre-existing (pre-upgrade) passcode file at startup.
void ensureAuthStoragePermissions();

// DISK-11: the disk-analysis cache was never pruned, so stale entries and
// `.corrupt-*` quarantine files accumulated indefinitely. Once per process
// startup, not on every scan (see diskAnalysis.ts for what this can and
// cannot delete).
void pruneDiskAnalysisCache().catch((error) => {
  console.error("[deckos] Failed to prune disk analysis cache at startup:", error);
});

let fatalExitScheduled = false;
let runningServer: { close: (callback?: (error?: Error) => void) => unknown } | null =
  null;

function scheduleFatalExit(
  kind: "uncaughtException" | "unhandledRejection",
  detail: unknown
) {
  // Dedupe before logging: a cascade of rejections inside the 50ms window would
  // otherwise dump a full stack trace each, which can include config contents
  // captured mid-write.
  if (fatalExitScheduled) {
    return;
  }
  fatalExitScheduled = true;
  const payload = detail instanceof Error ? detail.stack || detail.message : detail;
  console.error(`[deckos] Fatal ${kind}; exiting for supervised restart`, payload);
  process.exitCode = 1;
  // Stop accepting new connections. The 50ms timer below is far too short for
  // in-flight requests to actually drain; the benefit is that no *new* request
  // can start a write that the exit would then truncate.
  try {
    runningServer?.close();
  } catch (error) {
    console.error("[deckos] Failed to close server during fatal exit", error);
  }
  setTimeout(() => {
    process.exit(1);
  }, 50).unref();
}

process.on("uncaughtException", (error) => {
  scheduleFatalExit("uncaughtException", error);
});

process.on("unhandledRejection", (reason) => {
  scheduleFatalExit("unhandledRejection", reason);
});

const app = createServerApp();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isProduction = process.env.NODE_ENV === "production";
const clientDistPath = isProduction
  ? join(__dirname, "../../client/dist")
  : join(__dirname, "../../../client/dist");

if (isProduction) {
  app.use("*", serveStatic({ root: clientDistPath }));

  app.notFound((c) => {
    const path = c.req.path;

    if (path.startsWith("/api/")) {
      return c.json({ error: "Not found" }, 404);
    }

    const indexPath = join(clientDistPath, "index.html");
    try {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    } catch (err) {
      console.error("Failed to serve index.html:", err);
      return c.json({ error: "Server configuration error" }, 500);
    }
  });
}

const portEnv = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN;
const port = Number.isFinite(portEnv) ? portEnv : isProduction ? 3000 : 3001;

if (isProduction) {
  const indexPath = join(clientDistPath, "index.html");
  try {
    if (!existsSync(indexPath)) {
      throw new Error("File not found");
    }
  } catch {
    console.error(`[ERROR] Client build not found at: ${clientDistPath}`);
    console.error('Run "npm run build" before starting in production mode.');
    process.exit(1);
  }
}

try {
  const server = serve({
    fetch: app.fetch,
    port,
  });
  runningServer = server;

  server.on("listening", () => {
    console.log(`[deckos] server running on http://localhost:${port}`);
  });

  server.on("error", (error) => {
    console.error("[deckos] Server error:", error);
    process.exit(1);
  });
} catch (error) {
  console.error("[deckos] Failed to start server:", error);
  process.exit(1);
}
