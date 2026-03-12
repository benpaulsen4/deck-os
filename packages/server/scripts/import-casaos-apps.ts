import fs from "fs-extra";
import * as path from "node:path";
import { parse } from "yaml";
import { APPS_DIR } from "../src/lib/config.js";
import { AppMetadataSchema, ComposeFileSchema } from "../src/lib/schema.js";

type CasaComposeMeta = {
  title?: string;
  icon?: string;
  description?: string;
};

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function slugifyId(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return s || "app";
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let id = base;
  let i = 2;
  while (used.has(id)) {
    const suffix = `-${i}`;
    const maxBase = Math.max(1, 64 - suffix.length);
    id = `${base.slice(0, maxBase)}${suffix}`;
    i++;
  }
  used.add(id);
  return id;
}

function pickLocalizedText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const rec = value as Record<string, unknown>;
  const preferred = ["en_US", "en_GB", "en"];
  for (const k of preferred) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function firstParagraph(text: string, maxLen: number): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return "";
  const para = t.split(/\n\s*\n/)[0]?.trim() ?? "";
  const oneLine = para.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

function extractCasaOSMetaFromCompose(composeYaml: string): CasaComposeMeta {
  try {
    const parsed = parse(composeYaml) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const root = parsed as Record<string, unknown>;
    const xCasa = root["x-casaos"];
    if (!xCasa || typeof xCasa !== "object" || Array.isArray(xCasa)) return {};
    const x = xCasa as Record<string, unknown>;
    const title =
      pickLocalizedText(x.title) ||
      (typeof x.name === "string" ? x.name.trim() : "");
    const icon = typeof x.icon === "string" ? x.icon.trim() : "";
    const description = pickLocalizedText(x.description) || pickLocalizedText(x.tagline);
    return {
      title: title || undefined,
      icon: icon || undefined,
      description: description || undefined,
    };
  } catch {
    return {};
  }
}

function getComposePath(dir: string): string | null {
  const yml = path.join(dir, "docker-compose.yml");
  if (fs.existsSync(yml)) return yml;
  const yaml = path.join(dir, "docker-compose.yaml");
  if (fs.existsSync(yaml)) return yaml;
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseHostPort(entry: unknown): string {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    if (parts.length < 2) return "";
    return parts[0]?.replace(/^[^0-9]*/, "").replace(/[^0-9].*$/, "") ?? "";
  }
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    if (e.published !== undefined) return String(e.published);
  }
  return "";
}

function inferUrlFromCompose(composeYaml: string, host: string): string {
  try {
    const parsed = parse(composeYaml) as unknown;
    if (!parsed || typeof parsed !== "object") return "";
    const root = parsed as Record<string, unknown>;
    const services = root.services;
    if (!services || typeof services !== "object" || Array.isArray(services)) return "";
    for (const svc of Object.values(services as Record<string, unknown>)) {
      if (!svc || typeof svc !== "object" || Array.isArray(svc)) continue;
      const ports = (svc as Record<string, unknown>).ports;
      if (!Array.isArray(ports)) continue;
      for (const portEntry of ports) {
        const hostPort = parseHostPort(portEntry);
        if (/^\d+$/.test(hostPort)) return `http://${host}:${hostPort}`;
      }
    }
    return "";
  } catch {
    return "";
  }
}

async function collectSourceAppDirs(srcDir: string): Promise<string[]> {
  const directCompose = getComposePath(srcDir);
  if (directCompose) return [srcDir];

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appDir = path.join(srcDir, entry.name);
    if (getComposePath(appDir)) dirs.push(appDir);
  }
  return dirs;
}

async function getNextOrder(outDir: string): Promise<number> {
  const exists = await fs.pathExists(outDir);
  if (!exists) return 0;
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  let maxOrder = -1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(outDir, entry.name, "metadata.json");
    if (!(await fs.pathExists(metadataPath))) continue;
    try {
      const parsed = await fs.readJson(metadataPath);
      const metadata = AppMetadataSchema.parse(parsed);
      if (metadata.order > maxOrder) maxOrder = metadata.order;
    } catch {
      continue;
    }
  }
  return maxOrder + 1;
}

async function main() {
  const srcDir =
    getArg("--src") || (process.platform === "linux" ? "/var/lib/casaos/apps" : "");
  const outDirArg = getArg("--out") || APPS_DIR;
  const outDir = path.isAbsolute(outDirArg)
    ? outDirArg
    : path.resolve(process.cwd(), outDirArg);
  const host = getArg("--host") || "localhost";
  const overwrite = hasFlag("--overwrite");
  const dryRun = hasFlag("--dry-run");

  if (!srcDir) {
    throw new Error("Missing --src");
  }
  if (!(await fs.pathExists(srcDir))) {
    throw new Error(`CasaOS app folder not found: ${srcDir}`);
  }

  const sourceAppDirs = await collectSourceAppDirs(srcDir);
  if (sourceAppDirs.length === 0) {
    throw new Error(`No CasaOS app directories found under: ${srcDir}`);
  }

  if (!dryRun) {
    await fs.ensureDir(outDir);
  }

  const existingEntries = (await fs.pathExists(outDir))
    ? await fs.readdir(outDir, { withFileTypes: true })
    : [];
  const usedIds = new Set(existingEntries.filter((e) => e.isDirectory()).map((e) => e.name));
  let nextOrder = await getNextOrder(outDir);

  let imported = 0;
  let skipped = 0;
  let overwritten = 0;
  const now = new Date().toISOString();

  for (const appDir of sourceAppDirs) {
    const folderName = path.basename(appDir);
    const composePath = getComposePath(appDir);
    if (!composePath) {
      skipped++;
      continue;
    }

    const composeYaml = await fs.readFile(composePath, "utf-8");
    try {
      const parsed = parse(composeYaml);
      ComposeFileSchema.parse(parsed);
    } catch {
      skipped++;
      continue;
    }

    const appfilePath = path.join(appDir, "appfile.json");
    let name = folderName;
    let description = "";
    let icon = "";

    if (await fs.pathExists(appfilePath)) {
      try {
        const appfile = (await fs.readJson(appfilePath)) as Record<string, unknown>;
        if (typeof appfile.title === "string" && appfile.title.trim()) name = appfile.title.trim();
        if (typeof appfile.overview === "string" && appfile.overview.trim()) {
          description = appfile.overview.trim();
        } else if (typeof appfile.tagline === "string" && appfile.tagline.trim()) {
          description = appfile.tagline.trim();
        }
        if (typeof appfile.icon === "string" && isHttpUrl(appfile.icon)) {
          icon = appfile.icon;
        }
      } catch {
        continue;
      }
    }

    const composeMeta = extractCasaOSMetaFromCompose(composeYaml);
    if (!description && composeMeta.description) {
      description = firstParagraph(composeMeta.description, 240);
    }
    if (!icon && composeMeta.icon && isHttpUrl(composeMeta.icon)) {
      icon = composeMeta.icon;
    }
    if (name === folderName && composeMeta.title) {
      name = composeMeta.title;
    }

    const baseId = slugifyId(folderName);
    const existingPath = path.join(outDir, baseId);
    const canOverwriteBase =
      overwrite &&
      (await fs.pathExists(existingPath)) &&
      (await fs.pathExists(path.join(existingPath, "metadata.json"))) &&
      (await fs.pathExists(path.join(existingPath, "docker-compose.yml")));

    const appId = canOverwriteBase ? baseId : ensureUniqueId(baseId, usedIds);
    const targetDir = path.join(outDir, appId);
    const targetMetadataPath = path.join(targetDir, "metadata.json");
    const targetComposePath = path.join(targetDir, "docker-compose.yml");
    const targetExists = await fs.pathExists(targetDir);

    if (targetExists && !overwrite && !canOverwriteBase) {
      skipped++;
      continue;
    }

    let createdAt = now;
    let order = nextOrder;
    if (targetExists && overwrite && (await fs.pathExists(targetMetadataPath))) {
      try {
        const oldMetadata = AppMetadataSchema.parse(await fs.readJson(targetMetadataPath));
        createdAt = oldMetadata.createdAt;
        order = oldMetadata.order;
      } catch {
        createdAt = now;
        order = nextOrder;
      }
    } else {
      nextOrder++;
    }

    const metadata = AppMetadataSchema.parse({
      id: appId,
      name,
      icon,
      url: inferUrlFromCompose(composeYaml, host),
      description,
      order,
      createdAt,
      updatedAt: now,
    });

    if (!dryRun) {
      await fs.ensureDir(targetDir);
      await fs.writeJson(targetMetadataPath, metadata, { spaces: 2 });
      await fs.writeFile(targetComposePath, composeYaml, "utf-8");
    }

    if (targetExists) {
      overwritten++;
    } else {
      imported++;
    }
  }

  process.stdout.write(
    `CasaOS import complete: ${imported} imported, ${overwritten} overwritten, ${skipped} skipped -> ${outDir}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
