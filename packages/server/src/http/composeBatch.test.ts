import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_QUEUED_COMPOSE_PARSES } from "../lib/composeParser.js";
import { DATA_DIR } from "../lib/config.js";
import { measureEventLoopGap } from "../lib/eventLoopGap.testUtil.js";
import * as authService from "../services/auth.js";
import { createServerApp } from "./appWiring.js";

const BATCH_SIZE = MAX_QUEUED_COMPOSE_PARSES + 4;
const RESPONSIVE_GAP_MS = 500;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-compose-batch-"));
  authService.setAuthStoragePathForTests(root);
});

afterEach(async () => {
  authService.setAuthStoragePathForTests(DATA_DIR);
  await fs.remove(root);
});

/** About 200 ms to parse: enough that a batch on the main thread stalls for seconds. */
function slowValidCompose(): string {
  const keys = Array.from({ length: 6500 }, (_, i) => `k${i}: 1`).join("\n");
  return `services:\n  web:\n    image: nginx:latest\n${keys}\n`;
}

test(
  "a batch of slow validations cannot stall the server",
  { timeout: 30_000 },
  async () => {
    const composeYaml = slowValidCompose();
    const input = Object.fromEntries(
      Array.from({ length: BATCH_SIZE }, (_, index) => [index, { composeYaml }])
    );
    const route = Array<string>(BATCH_SIZE).fill("apps.validateCompose").join(",");

    const { gapMs, work } = await measureEventLoopGap(async () => {
      const response = await createServerApp().request(`/api/trpc/${route}?batch=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return (await response.json()) as Array<{
        result?: { data: { valid: boolean } };
        error?: { data: { code: string } };
      }>;
    });
    const results = await work;

    expect(gapMs).toBeLessThan(RESPONSIVE_GAP_MS);
    expect(results.filter((call) => call.result?.data.valid === true)).toHaveLength(
      MAX_QUEUED_COMPOSE_PARSES
    );
    expect(
      results.filter((call) => call.error?.data.code === "TOO_MANY_REQUESTS")
    ).toHaveLength(BATCH_SIZE - MAX_QUEUED_COMPOSE_PARSES);
  }
);
