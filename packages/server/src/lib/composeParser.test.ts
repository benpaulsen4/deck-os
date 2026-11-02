import { describe, expect, test } from "vitest";
import {
  ComposeParserBusyError,
  MAX_QUEUED_COMPOSE_PARSES,
  readComposeImages,
  validateComposeYaml,
} from "./composeParser.js";
import { measureEventLoopGap } from "./eventLoopGap.testUtil.js";
import { MAX_COMPOSE_YAML_CHARS } from "./schema.js";

const VALID_COMPOSE = "services:\n  web:\n    image: nginx:latest\n";

// Far above a timer's normal jitter, far below the 10+ seconds this shape blocks for.
const RESPONSIVE_GAP_MS = 1000;
const SLOW_PARSE_TEST_MS = 30_000;

/** The YAML library's duplicate-key check makes this take over 10 s to parse. */
function manyUniqueKeysYaml(chars: number): string {
  return Array.from({ length: Math.floor(chars / 10) }, (_, i) => `k${i}: 1`).join("\n");
}

/** Costs about 250 MB of heap to parse at the size limit. */
function flowSequenceYaml(chars: number): string {
  return `[${"a,".repeat(Math.floor(chars / 2) - 1)}a]`;
}

function largeRealisticCompose(chars: number): string {
  const service = (i: number) =>
    `  service-${i}:\n    image: registry.example.com/team/service-${i}:1.2.3\n` +
    `    restart: unless-stopped\n    environment:\n      - LOG_LEVEL=info\n` +
    `      - PORT=${8000 + i}\n    ports:\n      - "${8000 + i}:${8000 + i}"\n`;
  let yaml = "services:\n";
  for (let i = 0; yaml.length + service(i).length <= chars; i += 1) {
    yaml += service(i);
  }
  return yaml;
}

describe("validateComposeYaml", () => {
  test("accepts a normal compose file", async () => {
    await expect(validateComposeYaml(VALID_COMPOSE)).resolves.toBeUndefined();
  });

  test("accepts the largest realistic file the size limit allows, within the default limits", async () => {
    const yaml = largeRealisticCompose(MAX_COMPOSE_YAML_CHARS);
    expect(yaml.length).toBeGreaterThan(MAX_COMPOSE_YAML_CHARS - 1024);

    await expect(validateComposeYaml(yaml)).resolves.toBeUndefined();
  });

  test("rejects invalid YAML with the parser's message", async () => {
    await expect(validateComposeYaml("services: [")).rejects.toThrow(/flow sequence/i);
  });

  test("rejects valid YAML that is not a compose file", async () => {
    await expect(validateComposeYaml("version: '3'\n")).rejects.toThrow(/services/);
  });

  test(
    "leaves the event loop free during the slowest parse, and gives up at the time limit",
    async () => {
      const yaml = manyUniqueKeysYaml(MAX_COMPOSE_YAML_CHARS);

      const { gapMs, work } = await measureEventLoopGap(() =>
        validateComposeYaml(yaml, { timeLimitMs: 1500 })
      );

      expect(gapMs).toBeLessThan(RESPONSIVE_GAP_MS);
      await expect(work).rejects.toThrow(/too long/i);
    },
    SLOW_PARSE_TEST_MS
  );

  test(
    "survives a parse that exceeds the memory limit",
    async () => {
      await expect(
        validateComposeYaml(flowSequenceYaml(MAX_COMPOSE_YAML_CHARS), { heapLimitMb: 32 })
      ).rejects.toThrow(/too much memory/i);

      await expect(validateComposeYaml(VALID_COMPOSE)).resolves.toBeUndefined();
    },
    SLOW_PARSE_TEST_MS
  );

  test("carries on after a parse that hit the time limit", async () => {
    await expect(validateComposeYaml(VALID_COMPOSE, { timeLimitMs: 0 })).rejects.toThrow(
      /too long/i
    );

    await expect(validateComposeYaml(VALID_COMPOSE)).resolves.toBeUndefined();
  });

  test(
    "turns away parses past the queue limit, then accepts them again once it drains",
    async () => {
      const accepted = Array.from({ length: MAX_QUEUED_COMPOSE_PARSES }, () =>
        validateComposeYaml(VALID_COMPOSE)
      );

      await expect(validateComposeYaml(VALID_COMPOSE)).rejects.toBeInstanceOf(
        ComposeParserBusyError
      );

      await expect(Promise.all(accepted)).resolves.toBeDefined();
      await expect(validateComposeYaml(VALID_COMPOSE)).resolves.toBeUndefined();
    },
    SLOW_PARSE_TEST_MS
  );
});

describe("readComposeImages", () => {
  test("lists each service's image, ignoring services without one", async () => {
    const yaml =
      "services:\n  web:\n    image: ' nginx:latest '\n  db:\n    image: postgres:16\n" +
      "  built:\n    build: .\n";

    await expect(readComposeImages(yaml)).resolves.toEqual([
      "nginx:latest",
      "postgres:16",
    ]);
  });

  test.each([
    ["a scalar document", "just text"],
    ["a file without services", "version: '3'\n"],
  ])("finds no images in %s", async (_name, yaml) => {
    await expect(readComposeImages(yaml)).resolves.toEqual([]);
  });

  test("rejects invalid YAML", async () => {
    await expect(readComposeImages("services: [")).rejects.toThrow(/flow sequence/i);
  });

  test(
    "leaves the event loop free during the slowest parse",
    async () => {
      const yaml = manyUniqueKeysYaml(MAX_COMPOSE_YAML_CHARS);

      const { gapMs, work } = await measureEventLoopGap(() =>
        readComposeImages(yaml, { timeLimitMs: 1500 })
      );

      expect(gapMs).toBeLessThan(RESPONSIVE_GAP_MS);
      await expect(work).rejects.toThrow(/too long/i);
    },
    SLOW_PARSE_TEST_MS
  );
});
