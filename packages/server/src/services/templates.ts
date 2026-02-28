import * as appsService from "./apps.js";
import fs from "fs-extra";
import * as path from "node:path";

export type TemplateParameter = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "port" | "path" | "enum";
  defaultValue?: string;
  description?: string;
  required?: boolean;
  options?: string[];
};

export type TemplateSummary = {
  id: string;
  title: string;
  description: string;
  categories: string[];
  icon: string;
};

export type TemplateDetail = TemplateSummary & {
  webUrlTemplate: string;
  composeTemplate: string;
  parameters: TemplateParameter[];
};

type ListTemplatesInput = {
  query: string;
  category: string;
  page: number;
  pageSize: number;
};

type ListTemplatesOutput = {
  items: TemplateSummary[];
  total: number;
  categories: string[];
};

type DeployTemplateInput = {
  templateId: string;
  name: string;
  description: string;
  icon: string;
  url: string;
  parameters: Record<string, string>;
  composeOverride?: string;
};

type TemplateJson = {
  id: string;
  title: string;
  description?: string;
  categories?: string[];
  icon?: string;
  webUrlTemplate?: string;
  parameters?: TemplateParameter[];
};

const builtInTemplates: TemplateDetail[] = [
  {
    id: "nginx",
    title: "Nginx",
    description: "Simple Nginx web server.",
    categories: ["WEB"],
    icon: "",
    webUrlTemplate: "http://{{DECKOS_HOST}}:{{WEB_PORT}}",
    parameters: [
      {
        key: "WEB_PORT",
        label: "WEB PORT",
        type: "port",
        defaultValue: "8080",
        required: true,
      },
    ],
    composeTemplate: `services:
  nginx:
    image: nginx:latest
    ports:
      - "{{WEB_PORT}}:80"
`,
  },
];

const LIBRARY_CACHE_MS = 2000;
let cachedLibrary: TemplateDetail[] | null = null;
let cachedAtMs = 0;
let templateDirById = new Map<string, string>();

function normalizeCategory(cat: string): string {
  return cat.trim();
}

function matchesQuery(summary: TemplateSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    summary.title.toLowerCase().includes(q) ||
    summary.description.toLowerCase().includes(q) ||
    summary.categories.some((c) => c.toLowerCase().includes(q))
  );
}

function matchesCategory(summary: TemplateSummary, category: string): boolean {
  if (!category) return true;
  const c = category.toLowerCase();
  return summary.categories.some((x) => x.toLowerCase() === c);
}

function getTemplatesDirCandidates(): string[] {
  const candidates: string[] = [];
  const env = process.env.DECKOS_TEMPLATES_DIR;
  if (env) candidates.push(env);
  candidates.push(path.join(process.cwd(), "server", "templates"));
  candidates.push(path.join(process.cwd(), "packages", "server", "templates"));
  candidates.push(path.join(process.cwd(), "templates"));
  return candidates;
}

async function findTemplatesDir(): Promise<string | null> {
  for (const c of getTemplatesDirCandidates()) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

function toAssetUrl(templateId: string, relPath: string): string {
  const cleaned = relPath.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return `/api/templates/assets/${encodeURIComponent(templateId)}/${cleaned}`;
}

async function loadDiskLibrary(): Promise<TemplateDetail[]> {
  const templatesDir = await findTemplatesDir();
  if (!templatesDir) return [];

  const entries = await fs.readdir(templatesDir, { withFileTypes: true });
  const templates: TemplateDetail[] = [];
  const dirById = new Map<string, string>();

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const templateDir = path.join(templatesDir, e.name);
    const jsonPath = path.join(templateDir, "template.json");
    const composePath = path.join(templateDir, "docker-compose.yml");
    if (!(await fs.pathExists(jsonPath)) || !(await fs.pathExists(composePath))) continue;

    let json: TemplateJson;
    try {
      json = (await fs.readJson(jsonPath)) as TemplateJson;
    } catch {
      continue;
    }
    if (!json || typeof json.id !== "string" || typeof json.title !== "string") continue;

    let composeTemplate = "";
    try {
      composeTemplate = await fs.readFile(composePath, "utf-8");
    } catch {
      continue;
    }

    const categories = Array.isArray(json.categories)
      ? json.categories.filter((c) => typeof c === "string")
      : [];

    let icon = typeof json.icon === "string" ? json.icon.trim() : "";
    if (
      icon &&
      (icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("/"))
    ) {
      // keep
    } else if (icon) {
      const assetPath = path.join(templateDir, icon);
      icon = (await fs.pathExists(assetPath)) ? toAssetUrl(json.id, icon) : "";
    }

    templates.push({
      id: json.id,
      title: json.title,
      description: typeof json.description === "string" ? json.description : "",
      categories,
      icon,
      webUrlTemplate: typeof json.webUrlTemplate === "string" ? json.webUrlTemplate : "",
      composeTemplate,
      parameters: Array.isArray(json.parameters) ? json.parameters : [],
    });
    dirById.set(json.id, templateDir);
  }

  templates.sort((a, b) => a.title.localeCompare(b.title));
  templateDirById = dirById;
  return templates;
}

async function getLibrary(): Promise<TemplateDetail[]> {
  const now = Date.now();
  if (cachedLibrary && now - cachedAtMs < LIBRARY_CACHE_MS) return cachedLibrary;
  const disk = await loadDiskLibrary().catch(() => []);
  cachedLibrary = disk.length ? disk : builtInTemplates;
  cachedAtMs = now;
  return cachedLibrary;
}

export async function listTemplates(
  input: ListTemplatesInput
): Promise<ListTemplatesOutput> {
  const lib = await getLibrary();
  const summaries: TemplateSummary[] = lib.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    categories: t.categories,
    icon: t.icon,
  }));

  const filteredByQuery = summaries.filter((t) => matchesQuery(t, input.query));
  const filtered = filteredByQuery.filter((t) => matchesCategory(t, input.category));

  const categories = Array.from(
    new Set(
      filteredByQuery.flatMap((t) => t.categories.map(normalizeCategory)).filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

  const total = filtered.length;
  const start = (input.page - 1) * input.pageSize;
  const end = start + input.pageSize;

  return {
    items: filtered.slice(start, end),
    total,
    categories,
  };
}

export async function getTemplate(id: string): Promise<TemplateDetail> {
  const lib = await getLibrary();
  const found = lib.find((t) => t.id === id);
  if (!found) {
    throw new Error(`Template not found: ${id}`);
  }
  return found;
}

export async function getTemplateAssetPath(
  templateId: string,
  assetRelPath: string
): Promise<string | null> {
  await getLibrary();
  const templateDir = templateDirById.get(templateId);
  if (!templateDir) return null;
  const cleaned = assetRelPath.replace(/^[\\/]+/, "");
  const resolved = path.resolve(templateDir, cleaned);
  const base = path.resolve(templateDir) + path.sep;
  if (!resolved.startsWith(base)) return null;
  const exists = await fs.pathExists(resolved);
  if (!exists) return null;
  return resolved;
}

function renderPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = values[key];
    return v ?? "";
  });
}

export async function deployTemplate(input: DeployTemplateInput) {
  const template = await getTemplate(input.templateId);
  const resolvedParams: Record<string, string> = {};
  for (const p of template.parameters) {
    if (p.defaultValue !== undefined) {
      resolvedParams[p.key] = p.defaultValue;
    }
  }
  for (const [k, v] of Object.entries(input.parameters)) {
    resolvedParams[k] = v;
  }

  for (const p of template.parameters) {
    if (p.required) {
      const value = resolvedParams[p.key];
      if (!value || !value.trim()) {
        throw new Error(`Missing required parameter: ${p.label}`);
      }
    }
  }

  const composeYaml =
    input.composeOverride ?? renderPlaceholders(template.composeTemplate, resolvedParams);
  if (/\{\{[A-Z0-9_]+\}\}/.test(composeYaml)) {
    throw new Error("Unresolved template placeholders remain in compose file");
  }

  return await appsService.createApp(
    input.name,
    input.description,
    input.icon,
    input.url,
    composeYaml
  );
}
