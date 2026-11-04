import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DATA_DIR } from "../lib/config.js";
import { MAX_COMPOSE_YAML_CHARS } from "../lib/schema.js";
import * as authService from "../services/auth.js";
import { createServerApp } from "./appWiring.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-trpc-errors-"));
  authService.setAuthStoragePathForTests(root);
});

afterEach(async () => {
  authService.setAuthStoragePathForTests(DATA_DIR);
  await fs.remove(root);
});

type TrpcResponse = {
  result?: { data: { valid: boolean; message: string } };
  error?: { message: string; data: { code: string; httpStatus: number } };
};

async function callMutation(route: string, input: unknown): Promise<TrpcResponse> {
  const response = await createServerApp().request(`/api/trpc/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await response.json()) as TrpcResponse;
}

const OVERSIZED_COMPOSE = "a".repeat(MAX_COMPOSE_YAML_CHARS + 1);

test.each([
  ["apps.updateCompose", { id: "my-app", composeYaml: OVERSIZED_COMPOSE }],
  [
    "apps.create",
    {
      name: "My App",
      description: "",
      icon: "",
      url: "",
      composeYaml: OVERSIZED_COMPOSE,
    },
  ],
  ["apps.validateCompose", { composeYaml: OVERSIZED_COMPOSE }],
])("%s reports an oversized file in one sentence", async (route, input) => {
  const { error } = await callMutation(route, input);

  expect(error?.message).toBe("Compose YAML must be 512 KiB or smaller");
  expect(error?.data).toMatchObject({ code: "BAD_REQUEST", httpStatus: 400 });
});

test("an input failure with zod's default wording names the field", async () => {
  const { error } = await callMutation("apps.create", {
    name: "",
    composeYaml: "services:\n  web:\n    image: nginx:latest\n",
  });

  expect(error?.message).toBe("name: Too small: expected string to have >=1 characters");
});

test("validateCompose reports a schema failure with its place in the file", async () => {
  const { result } = await callMutation("apps.validateCompose", {
    composeYaml: "services:\n  web:\n    ports: []\n",
  });

  expect(result?.data).toEqual({
    valid: false,
    message: "services.web.image: Invalid input: expected string, received undefined",
  });
});

test("saving a file that fails the schema gets the same message as validating it", async () => {
  const { error } = await callMutation("apps.updateCompose", {
    id: "my-app",
    composeYaml: "services:\n  web:\n    ports: []\n",
  });

  expect(error?.message).toBe(
    "services.web.image: Invalid input: expected string, received undefined"
  );
});

test("errors that do not come from zod keep their message", async () => {
  const { error } = await callMutation("apps.updateCompose", {
    id: "my-app",
    composeYaml: "services: [",
  });

  expect(error?.message).toMatch(/flow sequence/i);
});
