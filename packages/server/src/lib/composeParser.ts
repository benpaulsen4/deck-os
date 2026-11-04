import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { TRPCError } from "@trpc/server";
import type { ComposeParseRequest, ComposeParseResponse } from "./composeParseWorker.js";

/**
 * Compose YAML comes from callers, and parsing it blocks: the YAML library's duplicate-
 * key check makes a 512 KiB file of unique keys take over 10 seconds, and a flow sequence
 * of that size takes about 250 MB of heap. On the main thread that stops every other
 * request, and a tRPC batch can ask for it dozens of times with no chance to run anything
 * in between. So each parse gets a worker of its own that can be stopped, one at a time.
 *
 * Starting a worker costs tens of milliseconds, which does not matter for an action
 * someone clicks, and means nothing has to be cleaned up between parses.
 */

// The largest realistic file the size limit allows parses in well under a second.
const DEFAULT_TIME_LIMIT_MS = 5000;
// The worst parse at the size limit fits in 256 MB. A process-wide --max-old-space-size
// (including through NODE_OPTIONS) overrides this, leaving only the time limit in force.
const DEFAULT_HEAP_LIMIT_MB = 512;

// People save one compose file at a time. This limits how much queued YAML can pile up,
// and how long the last caller in the queue can wait for the time limits ahead of it.
export const MAX_QUEUED_COMPOSE_PARSES = 8;

// From source (`pnpm dev`, tests) the worker has to be loaded through tsx, which a
// production install does not have. A compiled worker just inherits the process's flags.
const isRunningFromSource = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(
  `./composeParseWorker.${isRunningFromSource ? "ts" : "js"}`,
  import.meta.url
);
const WORKER_EXEC_ARGV = isRunningFromSource
  ? ["--import", createRequire(import.meta.url).resolve("tsx")]
  : undefined;

export type ComposeParseLimits = { timeLimitMs?: number; heapLimitMb?: number };

export class ComposeParserBusyError extends TRPCError {
  constructor() {
    super({
      code: "TOO_MANY_REQUESTS",
      message: "Too many compose files are being checked. Try again shortly.",
    });
    this.name = "ComposeParserBusyError";
  }
}

function parseInWorker(
  request: ComposeParseRequest,
  { timeLimitMs, heapLimitMb }: ComposeParseLimits
): Promise<ComposeParseResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: request,
      execArgv: WORKER_EXEC_ARGV,
      resourceLimits: { maxOldGenerationSizeMb: heapLimitMb ?? DEFAULT_HEAP_LIMIT_MB },
    });
    worker.unref();

    // Settling waits for `exit`, so the next parse cannot start while this one still
    // holds its memory. The first outcome wins, whatever else happens during shutdown.
    let outcome: (() => void) | undefined;
    const finish = (settle: () => void) => {
      outcome ??= settle;
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error("Compose YAML took too long to parse"));
      });
    }, timeLimitMs ?? DEFAULT_TIME_LIMIT_MS);

    worker.once("message", (response: ComposeParseResponse) => {
      finish(() => {
        resolve(response);
      });
    });
    worker.once("error", (error: Error & { code?: string }) => {
      finish(() => {
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(new Error("Compose YAML needs too much memory to parse"));
          return;
        }
        console.error("[deckos] Compose parser worker failed:", error);
        reject(new Error("Compose YAML could not be parsed"));
      });
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      if (outcome) {
        outcome();
        return;
      }
      reject(new Error("Compose YAML could not be parsed"));
    });
  });
}

let queueTail: Promise<unknown> = Promise.resolve();
let queuedParses = 0;

async function parseCompose(
  request: ComposeParseRequest,
  limits: ComposeParseLimits
): Promise<{ images: string[] }> {
  if (queuedParses >= MAX_QUEUED_COMPOSE_PARSES) {
    throw new ComposeParserBusyError();
  }
  queuedParses += 1;
  const parsing = queueTail.then(() => parseInWorker(request, limits));
  queueTail = parsing.catch(() => undefined);
  try {
    const response = await parsing;
    if (!response.ok) {
      throw new Error(response.message);
    }
    return response;
  } finally {
    queuedParses -= 1;
  }
}

/** Rejects with the parser's or the schema's message when the file is not valid. */
export async function validateComposeYaml(
  composeYaml: string,
  limits: ComposeParseLimits = {}
): Promise<void> {
  await parseCompose({ operation: "validate", composeYaml }, limits);
}

export async function readComposeImages(
  composeYaml: string,
  limits: ComposeParseLimits = {}
): Promise<string[]> {
  const { images } = await parseCompose({ operation: "readImages", composeYaml }, limits);
  return images;
}
