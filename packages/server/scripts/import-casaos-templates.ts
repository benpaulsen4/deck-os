import fs from "fs-extra";
import * as path from "node:path";
import { parse, stringify } from "yaml";

type TemplateParameter = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "port" | "path" | "enum";
  defaultValue?: string;
  description?: string;
  required?: boolean;
  options?: string[];
};

type TemplateJson = {
  id: string;
  title: string;
  description: string;
  categories: string[];
  icon?: string;
  webUrlTemplate?: string;
  parameters: TemplateParameter[];
};

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function slugifyId(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return s || "template";
}

function ensureUniqueId(base: string, used: Set<string>): string {
  let id = base;
  let i = 2;
  while (used.has(id)) {
    id = `${base}-${i}`;
    i++;
  }
  used.add(id);
  return id;
}

function ensureUniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let i = 2;
  while (used.has(key)) {
    key = `${base}_${i}`;
    i++;
  }
  used.add(key);
  return key;
}

function isAbsolutePathLike(p: string): boolean {
  if (p.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  return false;
}

function guessVolumeDefaultFromTarget(target: string): string {
  const base = target.split("/").filter(Boolean).pop();
  if (!base) return "./data";
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `./${safe}`;
}

function normalizeCasaOSVolumeSource(source: string, target: string): string {
  const prefix = "/DATA/AppData/$AppID/";
  if (source.startsWith(prefix)) {
    const rest = source.slice(prefix.length);
    return `./${rest}`.replace(/\\/g, "/");
  }
  if (isAbsolutePathLike(source)) {
    return guessVolumeDefaultFromTarget(target);
  }
  return source;
}

function normalizeDockerImageTag(image: string): string {
  const raw = image.trim();
  if (!raw) return raw;
  if (raw.includes("@")) return raw;
  const lastSlash = raw.lastIndexOf("/");
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1 || lastColon < lastSlash) return raw;

  const name = raw.slice(0, lastColon);
  const tag = raw.slice(lastColon + 1);
  if (!tag) return raw;
  if (tag === "latest") return raw;
  if (/^v?\d/.test(tag)) return `${name}:latest`;
  return raw;
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

function extractCasaOSMetaFromCompose(composeYaml: string): {
  title?: string;
  category?: string;
  tagline?: string;
  description?: string;
  icon?: string;
} {
  try {
    const parsed = parse(composeYaml) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const root = parsed as Record<string, unknown>;
    const x = root["x-casaos"];
    if (!x || typeof x !== "object" || Array.isArray(x)) return {};
    const xObj = x as Record<string, unknown>;

    const title =
      pickLocalizedText(xObj["title"]) ||
      (typeof xObj["name"] === "string" ? xObj["name"] : "");
    const category =
      typeof xObj["category"] === "string"
        ? xObj["category"].trim()
        : pickLocalizedText(xObj["category"]);
    const tagline = pickLocalizedText(xObj["tagline"]);
    const description = pickLocalizedText(xObj["description"]);
    const icon = typeof xObj["icon"] === "string" ? xObj["icon"].trim() : "";

    return {
      title: title || undefined,
      category: category || undefined,
      tagline: tagline || undefined,
      description: description || undefined,
      icon: icon || undefined,
    };
  } catch {
    return {};
  }
}

function convertCasaOSComposeToTemplate(composeYaml: string): {
  composeTemplate: string;
  parameters: TemplateParameter[];
  webUrlTemplate: string;
} {
  const parsed = parse(composeYaml) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid docker-compose.yml");
  }

  const root = parsed as Record<string, unknown>;
  delete root["x-casaos"];
  delete root["name"];

  const services = root["services"];
  if (!services || typeof services !== "object") {
    throw new Error("Compose is missing services");
  }

  const usedKeys = new Set<string>(["DECKOS_HOST"]);
  const parameters: TemplateParameter[] = [];
  let webPortKey: string | null = null;

  const addParam = (p: TemplateParameter) => {
    const key = ensureUniqueKey(p.key, usedKeys);
    const label = p.label || key.replace(/_/g, " ");
    parameters.push({ ...p, key, label });
    return key;
  };

  const ensureStandardEnv = (key: "PUID" | "PGID" | "TZ", defaultValue: string) => {
    if (usedKeys.has(key)) return;
    addParam({
      key,
      label: key,
      type: key === "TZ" ? "string" : "number",
      defaultValue,
      required: false,
    });
  };

  const servicesObj = services as Record<string, unknown>;
  for (const [serviceName, svcVal] of Object.entries(servicesObj)) {
    if (!svcVal || typeof svcVal !== "object") continue;
    const svc = svcVal as Record<string, unknown>;

    delete svc["x-casaos"];
    delete svc["container_name"];

    if (typeof svc.image === "string") {
      svc.image = normalizeDockerImageTag(svc.image);
    }

    const env = svc["environment"];
    if (env && typeof env === "object" && !Array.isArray(env)) {
      const envObj = env as Record<string, unknown>;
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof v !== "string") continue;
        if (v.includes("$PUID")) {
          ensureStandardEnv("PUID", "1000");
          envObj[k] = v.replaceAll("$PUID", "{{PUID}}");
        }
        if (v.includes("$PGID")) {
          ensureStandardEnv("PGID", "1000");
          envObj[k] = (envObj[k] as string).replaceAll("$PGID", "{{PGID}}");
        }
        if (v.includes("$TZ")) {
          ensureStandardEnv("TZ", "UTC");
          envObj[k] = (envObj[k] as string).replaceAll("$TZ", "{{TZ}}");
        }
      }
    }

    const ports = svc["ports"];
    if (Array.isArray(ports)) {
      for (let i = 0; i < ports.length; i++) {
        const entry = ports[i];
        const containerPort = (() => {
          if (typeof entry === "string") {
            const parts = entry.split(":");
            if (parts.length >= 2) return parts[1];
            return null;
          }
          if (entry && typeof entry === "object") {
            const portObj = entry as Record<string, unknown>;
            if (portObj.target !== undefined) return String(portObj.target);
          }
          return null;
        })();

        if (!containerPort) continue;
        const baseKey = !webPortKey
          ? "WEB_PORT"
          : `PORT_${serviceName}_${containerPort}`
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, "_");

        if (typeof entry === "string") {
          const parts = entry.split(":");
          if (parts.length >= 2) {
            const hostPort = parts[0];
            const key = addParam({
              key: baseKey,
              label: baseKey.replace(/_/g, " "),
              type: "port",
              defaultValue: hostPort,
              required: !webPortKey,
            });
            if (!webPortKey) webPortKey = key;
            parts[0] = `{{${key}}}`;
            ports[i] = parts.join(":");
          }
        } else if (entry && typeof entry === "object") {
          const portObj = entry as Record<string, unknown>;
          if (portObj.published !== undefined) {
            const hostPort = String(portObj.published);
            const key = addParam({
              key: baseKey,
              label: baseKey.replace(/_/g, " "),
              type: "port",
              defaultValue: hostPort,
              required: !webPortKey,
            });
            if (!webPortKey) webPortKey = key;
            portObj.published = `{{${key}}}`;
          }
        }
      }
    }

    const volumes = svc["volumes"];
    if (Array.isArray(volumes)) {
      for (let i = 0; i < volumes.length; i++) {
        const entry = volumes[i];
        if (typeof entry === "string") {
          const parts = entry.split(":");
          if (parts.length >= 2) {
            const source = parts[0];
            const target = parts[1];
            const normalizedDefault = normalizeCasaOSVolumeSource(source, target);
            const baseKey = `VOLUME_${serviceName}_${target}`
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, "_");
            const key = addParam({
              key: baseKey,
              label: `${serviceName} ${target}`.toUpperCase(),
              type: "path",
              defaultValue: normalizedDefault,
              required: true,
            });
            parts[0] = `{{${key}}}`;
            volumes[i] = parts.join(":");
          }
        } else if (entry && typeof entry === "object") {
          const volObj = entry as Record<string, unknown>;
          const source = volObj.source;
          const target = volObj.target;
          if (typeof source === "string" && typeof target === "string") {
            const normalizedDefault = normalizeCasaOSVolumeSource(source, target);
            const baseKey = `VOLUME_${serviceName}_${target}`
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, "_");
            const key = addParam({
              key: baseKey,
              label: `${serviceName} ${target}`.toUpperCase(),
              type: "path",
              defaultValue: normalizedDefault,
              required: true,
            });
            volObj.source = `{{${key}}}`;
          }
        }
      }
    }
  }

  const composeTemplate = stringify(root);
  const webUrlTemplate = webPortKey ? `http://{{DECKOS_HOST}}:{{${webPortKey}}}` : "";
  return { composeTemplate, parameters, webUrlTemplate };
}

async function main() {
  const srcDir =
    getArg("--src") || (process.platform === "win32" ? "D:/CasaOS-AppStore" : "");
  const outDirArg = getArg("--out") || "templates";
  const outDir = path.isAbsolute(outDirArg)
    ? outDirArg
    : path.join(process.cwd(), outDirArg);

  if (!srcDir) {
    throw new Error("Missing --src");
  }

  const appsDir = path.join(srcDir, "Apps");
  const exists = await fs.pathExists(appsDir);
  if (!exists) {
    throw new Error(`CasaOS AppStore Apps folder not found: ${appsDir}`);
  }

  await fs.ensureDir(outDir);
  await fs.emptyDir(outDir);

  const entries = await fs.readdir(appsDir, { withFileTypes: true });
  const usedIds = new Set<string>();
  let written = 0;
  let skipped = 0;

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folderName = e.name;
    const appDir = path.join(appsDir, folderName);

    const composePathYml = path.join(appDir, "docker-compose.yml");
    const composePathYaml = path.join(appDir, "docker-compose.yaml");
    const composePath = (await fs.pathExists(composePathYml))
      ? composePathYml
      : (await fs.pathExists(composePathYaml))
        ? composePathYaml
        : null;
    if (!composePath) {
      skipped++;
      continue;
    }

    const id = ensureUniqueId(slugifyId(folderName), usedIds);

    const appfilePath = path.join(appDir, "appfile.json");
    let title = folderName;
    let description = "";
    let categories: string[] = [];
    let remoteIcon = "";

    if (await fs.pathExists(appfilePath)) {
      try {
        const json = (await fs.readJson(appfilePath)) as Record<string, unknown>;
        if (typeof json.title === "string" && json.title.trim())
          title = json.title.trim();
        if (typeof json.overview === "string" && json.overview.trim()) {
          description = json.overview.trim();
        } else if (typeof json.tagline === "string" && json.tagline.trim()) {
          description = json.tagline.trim();
        }
        if (Array.isArray(json.category)) {
          categories = json.category.filter((x) => typeof x === "string") as string[];
        }
        if (typeof json.icon === "string") {
          remoteIcon = json.icon;
        }
      } catch {
        // ignore
      }
    }

    const iconCandidates = ["icon.png", "icon.jpg", "icon.jpeg", "icon.webp", "icon.gif"];
    let iconFile: string | null = null;
    for (const candidate of iconCandidates) {
      const p = path.join(appDir, candidate);
      if (await fs.pathExists(p)) {
        iconFile = p;
        break;
      }
    }

    const rawCompose = await fs.readFile(composePath, "utf-8");
    const composeMeta = extractCasaOSMetaFromCompose(rawCompose);
    const converted = (() => {
      try {
        return convertCasaOSComposeToTemplate(rawCompose);
      } catch {
        return null;
      }
    })();
    if (!converted) {
      skipped++;
      continue;
    }
    const { composeTemplate, parameters, webUrlTemplate } = converted;

    if (!description) {
      const picked =
        composeMeta.tagline || firstParagraph(composeMeta.description || "", 260);
      if (picked) description = picked;
    }
    if (categories.length === 0 && composeMeta.category) {
      categories = [composeMeta.category];
    }
    if (!remoteIcon && composeMeta.icon) {
      remoteIcon = composeMeta.icon;
    }
    if (title === folderName && composeMeta.title) {
      title = composeMeta.title;
    }

    const templateDir = path.join(outDir, id);
    const assetsDir = path.join(templateDir, "assets");
    await fs.ensureDir(assetsDir);

    const iconRel = iconFile ? `assets/${path.basename(iconFile)}` : "";
    if (iconFile) {
      await fs.copyFile(iconFile, path.join(assetsDir, path.basename(iconFile)));
    }

    const templateJson: TemplateJson = {
      id,
      title,
      description,
      categories,
      icon: iconRel || remoteIcon || "",
      webUrlTemplate,
      parameters,
    };

    await fs.writeJson(path.join(templateDir, "template.json"), templateJson, {
      spaces: 2,
    });
    await fs.writeFile(
      path.join(templateDir, "docker-compose.yml"),
      composeTemplate,
      "utf-8"
    );

    written++;
  }

  process.stdout.write(
    `Imported templates: ${written} written, ${skipped} skipped -> ${outDir}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
