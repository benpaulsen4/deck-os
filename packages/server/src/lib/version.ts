import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  version?: unknown;
};

function safeReadJson(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

export function getCurrentVersion(): string {
  const env = process.env.DECKOS_VERSION;
  if (env && env.trim()) return normalizeVersion(env);

  const cwdVersionPath = join(process.cwd(), "VERSION");
  if (existsSync(cwdVersionPath)) {
    try {
      const v = readFileSync(cwdVersionPath, "utf-8").trim();
      if (v) return normalizeVersion(v);
    } catch {
      // ignore
    }
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const candidates = [
    join(__dirname, "../../package.json"),
    join(__dirname, "../../../package.json"),
  ];

  for (const p of candidates) {
    const json = safeReadJson(p) as PackageJson | null;
    if (!json) continue;
    const v = json.version;
    if (typeof v === "string" && v.trim()) return normalizeVersion(v);
  }

  return "0.0.0";
}

