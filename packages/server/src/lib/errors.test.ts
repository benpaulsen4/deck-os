import { describe, expect, test } from "vitest";
import { z } from "zod";
import { formatZodError, getErrorMessage } from "./errors.js";

function zodErrorFrom(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) {
    throw new Error("Expected the value to be rejected");
  }
  return result.error;
}

describe("formatZodError", () => {
  test("leaves out a top-level field the message already names", () => {
    const schema = z.object({
      composeYaml: z.string().max(1, "Compose YAML is too long"),
      id: z.string().regex(/^a$/, "Invalid app id"),
    });

    expect(formatZodError(zodErrorFrom(schema, { composeYaml: "ab", id: "a" }))).toBe(
      "Compose YAML is too long"
    );
    expect(formatZodError(zodErrorFrom(schema, { composeYaml: "a", id: "b" }))).toBe(
      "Invalid app id"
    );
  });

  test("does not mistake part of a word for the field's name", () => {
    const schema = z.object({ id: z.string() });

    expect(formatZodError(zodErrorFrom(schema, {}))).toBe(
      "id: Invalid input: expected string, received undefined"
    );
  });

  test("keeps the path of a nested issue even when the message repeats its last part", () => {
    const schema = z.object({ services: z.record(z.string(), z.object({})) });

    expect(formatZodError(zodErrorFrom(schema, { services: { input: 1 } }))).toBe(
      "services.input: Invalid input: expected object, received number"
    );
  });

  test("gives only the message for an issue with no path", () => {
    expect(formatZodError(zodErrorFrom(z.string(), 1))).toBe(
      "Invalid input: expected string, received number"
    );
  });

  test("writes array positions in brackets", () => {
    const schema = z.object({ ports: z.array(z.string()) });

    expect(formatZodError(zodErrorFrom(schema, { ports: [1] }))).toBe(
      "ports[0]: Invalid input: expected string, received number"
    );
  });

  test("reports the first few issues and counts the rest", () => {
    const schema = z.array(z.string());

    expect(formatZodError(zodErrorFrom(schema, [1, 2, 3, 4, 5]))).toBe(
      "[0]: Invalid input: expected string, received number; " +
        "[1]: Invalid input: expected string, received number; " +
        "[2]: Invalid input: expected string, received number; " +
        "and 2 more"
    );
  });
});

describe("getErrorMessage", () => {
  test("formats a zod error instead of returning its raw JSON", () => {
    expect(getErrorMessage(zodErrorFrom(z.string(), 1))).toBe(
      "Invalid input: expected string, received number"
    );
  });

  test("returns the message of any other error", () => {
    expect(getErrorMessage(new Error("Compose YAML took too long to parse"))).toBe(
      "Compose YAML took too long to parse"
    );
  });
});
