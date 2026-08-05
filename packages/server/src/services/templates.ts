import * as appsService from "./apps.js";
import fs from "fs-extra";
import * as path from "node:path";
import { z } from "zod";
import { parseDocument, visit } from "yaml";

const TemplateParameterSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "port", "path", "enum"]),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

/**
 * `template.json` ships with the product but is still parsed, not cast: a
 * malformed `type` or an `options` that is a string rather than an array
 * silently weakens parameter validation for every deploy of that template.
 */
const TemplateJsonSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  categories: z.array(z.string()).optional(),
  icon: z.string().optional(),
  webUrlTemplate: z.string().optional(),
  parameters: z.array(TemplateParameterSchema).optional(),
});

export type TemplateParameter = z.infer<typeof TemplateParameterSchema>;

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

type TemplateJson = z.infer<typeof TemplateJsonSchema>;

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
      const parsed = TemplateJsonSchema.safeParse(await fs.readJson(jsonPath));
      if (!parsed.success) {
        console.warn(
          `[deckos] Skipping template ${e.name}: invalid template.json (${parsed.error.issues[0]?.message ?? "schema error"})`
        );
        continue;
      }
      json = parsed.data;
    } catch {
      continue;
    }

    // `getLibrary` resolves by first match while the asset map keeps the last
    // writer, so a duplicate id would serve one template's metadata with
    // another's assets. First definition wins, consistently.
    if (dirById.has(json.id)) {
      console.warn(
        `[deckos] Skipping template ${e.name}: duplicate template id "${json.id}"`
      );
      continue;
    }

    let composeTemplate: string;
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

const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Renders a compose template by setting parameter values as YAML *scalar nodes*
 * rather than splicing them into YAML text. A raw string replace lets a value
 * containing a newline open new mapping keys - `privileged: true`, extra bind
 * mounts - turning "fill in a port and a data path" into full compose
 * authorship. Going through the document API means the serializer decides how
 * each value is quoted, so a value can only ever be a value.
 *
 * Placeholders are swapped for inert alphanumeric sentinels *before* parsing:
 * a bare `KEY: {{SECRET}}` is a YAML flow mapping, not a string scalar, so
 * parsing the raw template first would lose those placeholders entirely (45 of
 * them across 14 shipped templates). The sentinel is a plain scalar in every
 * context a placeholder appears in, so the document keeps its original shape
 * and each substituted value inherits the surrounding scalar's quoting style.
 *
 * Two deliberate differences from the raw string replace this supersedes, both
 * reachable only in a bare (unquoted) scalar position:
 *  - a value that would re-parse as another type gets quoted, so an all-digit
 *    secret stays the string "12345" instead of becoming the number 12345;
 *  - an empty value renders as `KEY: ""` rather than `KEY:`, i.e. an empty
 *    string rather than null. For a compose environment variable that is the
 *    difference between "set to empty" and "unset, inherit from the host".
 */
export function renderComposeTemplate(
  template: string,
  values: Record<string, string>
): string {
  let sentinelBase = "DECKOSPLACEHOLDER";
  while (template.includes(sentinelBase)) sentinelBase += "X";

  const keysBySentinelIndex: string[] = [];
  const sentinelByKey = new Map<string, string>();
  const withSentinels = template.replace(PLACEHOLDER_PATTERN, (_m, key: string) => {
    let sentinel = sentinelByKey.get(key);
    if (!sentinel) {
      sentinel = `${sentinelBase}${keysBySentinelIndex.length}Z`;
      sentinelByKey.set(key, sentinel);
      keysBySentinelIndex.push(key);
    }
    return sentinel;
  });

  if (keysBySentinelIndex.length === 0) return template;

  const doc = parseDocument(withSentinels);
  if (doc.errors.length > 0) {
    throw new Error(`Template is not valid YAML: ${doc.errors[0].message}`);
  }

  const sentinelPattern = new RegExp(`${sentinelBase}(\\d+)Z`, "g");
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== "string") return;
      if (!node.value.includes(sentinelBase)) return;
      node.value = node.value.replace(
        sentinelPattern,
        (_m, index: string) => values[keysBySentinelIndex[Number(index)]] ?? ""
      );
    },
  });

  // lineWidth: 0 disables line folding, so re-serialising a template does not
  // reflow scalars that were fine as they were.
  const rendered = doc.toString({ lineWidth: 0 });

  // `visit`/`Scalar` only reaches values the parser models as scalars, so a
  // placeholder written in a comment, tag or anchor keeps its sentinel and is
  // never restored. The usual `{{...}}` net in deployTemplate cannot catch that
  // because the placeholder is already gone by then - fail loudly instead of
  // emitting a compose file with a sentinel baked into it.
  if (rendered.includes(sentinelBase)) {
    throw new Error(
      "Template placeholder appears outside a YAML value (comment, tag or anchor)"
    );
  }

  return rendered;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function normalizeTemplateParameterValue(
  parameter: TemplateParameter,
  rawValue: string
): string {
  const value = rawValue.trim();
  if (!value) {
    return value;
  }
  // Defence in depth alongside `renderComposeTemplate`: no parameter of any
  // type has a legitimate reason to carry a newline or other control character,
  // and those are what turn a value into extra compose structure.
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Invalid characters in parameter: ${parameter.label}`);
  }
  switch (parameter.type) {
    case "string":
      return value;
    case "number": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid number for parameter: ${parameter.label}`);
      }
      return String(parsed);
    }
    case "boolean": {
      const lower = value.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return "true";
      if (["false", "0", "no", "off"].includes(lower)) return "false";
      throw new Error(`Invalid boolean for parameter: ${parameter.label}`);
    }
    case "port": {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid port for parameter: ${parameter.label}`);
      }
      return String(parsed);
    }
    case "path": {
      const normalized = value.replace(/\\/g, "/");
      const looksRelative =
        normalized.startsWith("./") ||
        /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(normalized);
      const looksAbsolute = normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
      if (!looksRelative && !looksAbsolute) {
        throw new Error(`Invalid path for parameter: ${parameter.label}`);
      }
      if (normalized.includes("..") || normalized.includes("\0")) {
        throw new Error(`Invalid path for parameter: ${parameter.label}`);
      }
      return normalized;
    }
    case "enum": {
      const options = parameter.options ?? [];
      if (!Array.isArray(options) || !options.includes(value)) {
        throw new Error(`Invalid option for parameter: ${parameter.label}`);
      }
      return value;
    }
    default: {
      // Unreachable while the parameter schema validates `type`. Refuse rather
      // than falling through to "return the value unvalidated".
      const unknownType: never = parameter.type;
      throw new Error(
        `Unsupported parameter type "${String(unknownType)}" for parameter: ${parameter.label}`
      );
    }
  }
}

export async function deployTemplate(input: DeployTemplateInput) {
  const template = await getTemplate(input.templateId);
  const templateParameterByKey = new Map(template.parameters.map((p) => [p.key, p]));
  const resolvedParams: Record<string, string> = {};
  for (const p of template.parameters) {
    if (p.defaultValue !== undefined) {
      resolvedParams[p.key] = normalizeTemplateParameterValue(p, p.defaultValue);
    }
  }
  for (const [k, v] of Object.entries(input.parameters)) {
    const parameter = templateParameterByKey.get(k);
    if (!parameter) {
      throw new Error(`Unknown parameter: ${k}`);
    }
    resolvedParams[k] = normalizeTemplateParameterValue(parameter, v);
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
    input.composeOverride ??
    renderComposeTemplate(template.composeTemplate, resolvedParams);
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
