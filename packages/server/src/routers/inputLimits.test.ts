import type { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ZodError } from "zod";

const { reorderAppsMock, createAppMock, updateComposeMock, deployTemplateMock } =
  vi.hoisted(() => ({
    reorderAppsMock: vi.fn(async () => undefined),
    createAppMock: vi.fn(async () => ({ id: "app-1" })),
    updateComposeMock: vi.fn(async () => ({ id: "app-1" })),
    deployTemplateMock: vi.fn(async () => ({ id: "app-1" })),
  }));

vi.mock("../services/apps.js", () => ({
  reorderApps: reorderAppsMock,
  createApp: createAppMock,
  updateCompose: updateComposeMock,
}));

vi.mock("../services/templates.js", () => ({
  deployTemplate: deployTemplateMock,
}));

import {
  MAX_APP_IDS_PER_REQUEST,
  MAX_COMPOSE_YAML_CHARS,
  MAX_DEPLOY_PARAMETERS,
  MAX_DEPLOY_PARAMETER_VALUE_CHARS,
} from "../lib/schema.js";
import { appsRouter } from "./apps.js";
import { templatesRouter } from "./templates.js";

const context = {
  authEnabled: false,
  isAuthenticated: true,
  sessionToken: null,
  clientIp: "127.0.0.1",
};
const apps = appsRouter.createCaller(context);
const templates = templatesRouter.createCaller(context);

// Far below what validating these inputs element by element takes, far above what
// a rejection on size takes, so a slow CI machine cannot make it flaky.
const QUICK_REJECTION_MS = 1000;
const ATTACK_ELEMENT_COUNT = 3_000_000;

const VALID_COMPOSE = "services:\n  web:\n    image: nginx:latest\n";

/** Costs about 2 GB of heap and 6 seconds to parse at 4 MiB. */
function pathologicalYaml(chars: number): string {
  return `[${"a,".repeat(Math.floor(chars / 2))}]`;
}

async function expectInputRejection(
  call: () => Promise<unknown>
): Promise<{ issues: number; elapsedMs: number }> {
  const startedAt = performance.now();
  const error = (await call().then(
    () => {
      throw new Error("Expected the input to be rejected");
    },
    (reason: unknown) => reason
  )) as TRPCError;
  const elapsedMs = performance.now() - startedAt;
  expect(error.code).toBe("BAD_REQUEST");
  return { issues: (error.cause as ZodError).issues.length, elapsedMs };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apps.reorder orderedIds limit", () => {
  test("accepts the largest list a panel can send", async () => {
    const orderedIds = Array.from(
      { length: MAX_APP_IDS_PER_REQUEST },
      (_, index) => `app-${index}`
    );

    await expect(apps.reorder({ orderedIds })).resolves.toEqual({ success: true });
    expect(reorderAppsMock).toHaveBeenCalledWith(orderedIds);
  });

  test("rejects one id over the limit", async () => {
    const orderedIds = Array.from(
      { length: MAX_APP_IDS_PER_REQUEST + 1 },
      (_, index) => `app-${index}`
    );

    await expectInputRejection(() => apps.reorder({ orderedIds }));
    expect(reorderAppsMock).not.toHaveBeenCalled();
  });

  test("rejects millions of invalid ids with one issue, without checking each", async () => {
    const orderedIds = new Array<string>(ATTACK_ELEMENT_COUNT).fill("NOT A VALID ID");

    const { issues, elapsedMs } = await expectInputRejection(() =>
      apps.reorder({ orderedIds })
    );

    expect(issues).toBe(1);
    expect(elapsedMs).toBeLessThan(QUICK_REJECTION_MS);
  });
});

describe("templates.deploy parameters limit", () => {
  const deployInput = { templateId: "ragflow", name: "RAGFlow" };

  function parameters(count: number): Record<string, string> {
    return Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`KEY_${index}`, "value"])
    );
  }

  test("treats omitted parameters as none", async () => {
    await templates.deploy(deployInput);

    expect(deployTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: {} })
    );
  });

  test("accepts the largest parameter set allowed", async () => {
    const input = parameters(MAX_DEPLOY_PARAMETERS);

    await templates.deploy({ ...deployInput, parameters: input });

    expect(deployTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: input })
    );
  });

  test("rejects one parameter over the limit", async () => {
    await expectInputRejection(() =>
      templates.deploy({
        ...deployInput,
        parameters: parameters(MAX_DEPLOY_PARAMETERS + 1),
      })
    );
    expect(deployTemplateMock).not.toHaveBeenCalled();
  });

  test("rejects a million invalid parameters with one issue, without checking each", async () => {
    const input = parameters(1_000_000) as unknown as Record<string, string>;
    for (const key of Object.keys(input)) {
      (input as Record<string, unknown>)[key] = 1;
    }

    const { issues, elapsedMs } = await expectInputRejection(() =>
      templates.deploy({ ...deployInput, parameters: input })
    );

    expect(issues).toBe(1);
    expect(elapsedMs).toBeLessThan(QUICK_REJECTION_MS);
  });

  test("rejects a parameter value over the limit", async () => {
    await expectInputRejection(() =>
      templates.deploy({
        ...deployInput,
        parameters: { KEY: "x".repeat(MAX_DEPLOY_PARAMETER_VALUE_CHARS + 1) },
      })
    );
    expect(deployTemplateMock).not.toHaveBeenCalled();
  });

  test("still rejects parameters that are not an object", async () => {
    await expectInputRejection(() =>
      templates.deploy({
        ...deployInput,
        parameters: ["a"] as unknown as Record<string, string>,
      })
    );
  });
});

describe("compose YAML limit", () => {
  const atLimit = "#".repeat(MAX_COMPOSE_YAML_CHARS);
  const overLimit = "#".repeat(MAX_COMPOSE_YAML_CHARS + 1);

  test("apps.validateCompose still validates a normal file", async () => {
    await expect(apps.validateCompose({ composeYaml: VALID_COMPOSE })).resolves.toEqual({
      valid: true,
      message: "Compose YAML is valid",
    });
  });

  test("apps.validateCompose rejects oversized YAML before parsing it", async () => {
    const composeYaml = pathologicalYaml(4 * 1024 * 1024);

    const { elapsedMs } = await expectInputRejection(() =>
      apps.validateCompose({ composeYaml })
    );

    expect(elapsedMs).toBeLessThan(QUICK_REJECTION_MS);
  });

  test("apps.create accepts YAML at the limit and rejects it above", async () => {
    const input = { name: "Web" };

    await apps.create({ ...input, composeYaml: atLimit });
    expect(createAppMock).toHaveBeenCalledTimes(1);

    await expectInputRejection(() => apps.create({ ...input, composeYaml: overLimit }));
    expect(createAppMock).toHaveBeenCalledTimes(1);
  });

  test("apps.updateCompose accepts YAML at the limit and rejects it above", async () => {
    await apps.updateCompose({ id: "app-1", composeYaml: atLimit });
    expect(updateComposeMock).toHaveBeenCalledTimes(1);

    await expectInputRejection(() =>
      apps.updateCompose({ id: "app-1", composeYaml: overLimit })
    );
    expect(updateComposeMock).toHaveBeenCalledTimes(1);
  });

  test("templates.deploy accepts an override at the limit and rejects it above", async () => {
    const input = { templateId: "ragflow", name: "RAGFlow" };

    await templates.deploy({ ...input, composeOverride: atLimit });
    expect(deployTemplateMock).toHaveBeenCalledTimes(1);

    await expectInputRejection(() =>
      templates.deploy({ ...input, composeOverride: overLimit })
    );
    expect(deployTemplateMock).toHaveBeenCalledTimes(1);
  });
});
