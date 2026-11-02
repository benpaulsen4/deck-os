import { parentPort, workerData } from "node:worker_threads";
import { parse } from "yaml";
import { ComposeFileSchema } from "./composeSchema.js";
import { getErrorMessage } from "./errors.js";

export type ComposeParseRequest = {
  operation: "validate" | "readImages";
  composeYaml: string;
};

export type ComposeParseResponse =
  { ok: true; images: string[] } | { ok: false; message: string };

function readImages(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const services = (parsed as Record<string, unknown>).services;
  if (!services || typeof services !== "object") return [];
  return Object.values(services as Record<string, unknown>)
    .map((svc) => {
      if (!svc || typeof svc !== "object") return "";
      const image = (svc as Record<string, unknown>).image;
      return typeof image === "string" ? image : "";
    })
    .map((s: string) => s.trim())
    .filter(Boolean);
}

function run({ operation, composeYaml }: ComposeParseRequest): ComposeParseResponse {
  try {
    const parsed: unknown = parse(composeYaml);
    if (operation === "readImages") {
      return { ok: true, images: readImages(parsed) };
    }
    ComposeFileSchema.parse(parsed);
    return { ok: true, images: [] };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

parentPort?.postMessage(run(workerData as ComposeParseRequest));
