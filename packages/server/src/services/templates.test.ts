import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const createdDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function loadTemplatesModule() {
  vi.resetModules();
  vi.doMock("./apps.js", () => ({
    createApp: vi.fn(async (_n, _d, _i, _u, composeYaml: string) => ({
      id: "app-test",
      metadata: { id: "app-test" },
      composeYaml,
    })),
  }));
  const templates = await import("./templates.js");
  const apps = await import("./apps.js");
  return {
    templates,
    createAppMock: vi.mocked(apps.createApp),
  };
}

describe("templates service", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test("lists templates from disk with query/category filtering", async () => {
    const root = await createTempDir("deckos-templates-list-");
    const tplDir = path.join(root, "my-template");
    await fs.ensureDir(path.join(tplDir, "assets"));
    await fs.writeJson(path.join(tplDir, "template.json"), {
      id: "my-template",
      title: "My Template",
      description: "A searchable template",
      categories: ["WEB", "TOOLS"],
      icon: "assets/icon.png",
      webUrlTemplate: "http://{{DECKOS_HOST}}:{{PORT}}",
      parameters: [
        { key: "PORT", label: "PORT", type: "port", defaultValue: "8080", required: true },
      ],
    });
    await fs.writeFile(path.join(tplDir, "docker-compose.yml"), "services: {}\n", "utf8");
    await fs.writeFile(path.join(tplDir, "assets/icon.png"), "png", "utf8");
    process.env.DECKOS_TEMPLATES_DIR = root;

    const { templates } = await loadTemplatesModule();
    const result = await templates.listTemplates({
      query: "searchable",
      category: "WEB",
      page: 1,
      pageSize: 10,
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("my-template");
    expect(result.items[0]?.icon).toContain("/api/templates/assets/my-template/assets/icon.png");
    expect(result.categories).toContain("WEB");
  });

  test("resolves template asset paths and blocks traversal", async () => {
    const root = await createTempDir("deckos-templates-assets-");
    const tplDir = path.join(root, "asset-template");
    await fs.ensureDir(path.join(tplDir, "assets"));
    await fs.writeJson(path.join(tplDir, "template.json"), {
      id: "asset-template",
      title: "Asset Template",
      categories: ["WEB"],
    });
    await fs.writeFile(path.join(tplDir, "docker-compose.yml"), "services: {}\n", "utf8");
    await fs.writeFile(path.join(tplDir, "assets/icon.png"), "png", "utf8");
    process.env.DECKOS_TEMPLATES_DIR = root;

    const { templates } = await loadTemplatesModule();
    const good = await templates.getTemplateAssetPath("asset-template", "assets/icon.png");
    const bad = await templates.getTemplateAssetPath("asset-template", "../outside.txt");

    expect(good).toContain(path.join("asset-template", "assets", "icon.png"));
    expect(bad).toBeNull();
  });

  test("deployTemplate validates parameters and renders compose placeholders", async () => {
    const root = await createTempDir("deckos-templates-deploy-");
    const tplDir = path.join(root, "deploy-template");
    await fs.ensureDir(tplDir);
    await fs.writeJson(path.join(tplDir, "template.json"), {
      id: "deploy-template",
      title: "Deploy Template",
      categories: ["WEB"],
      parameters: [
        { key: "PORT", label: "Port", type: "port", defaultValue: "8080", required: true },
        { key: "MODE", label: "Mode", type: "enum", options: ["prod", "dev"], required: true },
      ],
    });
    await fs.writeFile(
      path.join(tplDir, "docker-compose.yml"),
      'services:\n  app:\n    image: nginx:latest\n    ports:\n      - "{{PORT}}:80"\n    environment:\n      - MODE={{MODE}}\n',
      "utf8"
    );
    process.env.DECKOS_TEMPLATES_DIR = root;

    const { templates, createAppMock } = await loadTemplatesModule();
    await expect(
      templates.deployTemplate({
        templateId: "deploy-template",
        name: "My App",
        description: "",
        icon: "",
        url: "",
        parameters: { MODE: "invalid" },
      })
    ).rejects.toThrow("Invalid option for parameter: Mode");

    await templates.deployTemplate({
      templateId: "deploy-template",
      name: "My App",
      description: "",
      icon: "",
      url: "",
      parameters: { MODE: "prod", PORT: "9090" },
    });

    expect(createAppMock).toHaveBeenCalledTimes(1);
    const composeYaml = createAppMock.mock.calls[0]?.[4];
    expect(typeof composeYaml).toBe("string");
    if (typeof composeYaml !== "string") {
      throw new Error("Expected compose YAML to be passed to createApp");
    }
    expect(composeYaml).toContain("9090:80");
    expect(composeYaml).toContain("MODE=prod");
    expect(composeYaml).not.toContain("{{");
  });

  test("parameter values cannot inject compose structure through newlines", async () => {
    const root = await createTempDir("deckos-templates-inject-");
    const tplDir = path.join(root, "inject-template");
    await fs.ensureDir(tplDir);
    await fs.writeJson(path.join(tplDir, "template.json"), {
      id: "inject-template",
      title: "Inject Template",
      categories: ["WEB"],
      parameters: [
        { key: "DATA_PATH", label: "Data path", type: "path", defaultValue: "./data" },
        { key: "TZ", label: "Timezone", type: "string", defaultValue: "UTC" },
      ],
    });
    await fs.writeFile(
      path.join(tplDir, "docker-compose.yml"),
      'services:\n  app:\n    image: nginx:latest\n    environment:\n      TZ: "{{TZ}}"\n    volumes:\n      - type: bind\n        source: "{{DATA_PATH}}"\n        target: /data\n',
      "utf8"
    );
    process.env.DECKOS_TEMPLATES_DIR = root;

    const { templates, createAppMock } = await loadTemplatesModule();

    const injection =
      '/srv/data"\n        target: /\n      - type: bind\n        source: "/';
    await expect(
      templates.deployTemplate({
        templateId: "inject-template",
        name: "Injected",
        description: "",
        icon: "",
        url: "",
        parameters: { DATA_PATH: injection },
      })
    ).rejects.toThrow("Invalid characters in parameter");

    // The untyped `string` parameter is guarded the same way.
    await expect(
      templates.deployTemplate({
        templateId: "inject-template",
        name: "Injected",
        description: "",
        icon: "",
        url: "",
        parameters: { TZ: "UTC\n    privileged: true" },
      })
    ).rejects.toThrow("Invalid characters in parameter");

    expect(createAppMock).not.toHaveBeenCalled();

    // Even if a control character slipped past validation, rendering through the
    // YAML document API keeps the value a value.
    const rendered = templates.renderComposeTemplate(
      'services:\n  app:\n    image: nginx:latest\n    volumes:\n      - type: bind\n        source: "{{DATA_PATH}}"\n        target: /data\n',
      { DATA_PATH: injection }
    );
    const parsedRendered = parse(rendered) as {
      services: { app: { volumes: unknown[]; privileged?: boolean } };
    };
    expect(parsedRendered.services.app.volumes).toHaveLength(1);
    expect(parsedRendered.services.app.privileged).toBeUndefined();
    expect(
      (parsedRendered.services.app.volumes[0] as { source: string }).source
    ).toBe(injection);
  });

  test("templates with an invalid template.json or a duplicate id are skipped", async () => {
    const root = await createTempDir("deckos-templates-validate-");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const good = path.join(root, "good");
    await fs.ensureDir(good);
    await fs.writeJson(path.join(good, "template.json"), {
      id: "shared-id",
      title: "Good",
      categories: ["WEB"],
      parameters: [{ key: "MODE", label: "Mode", type: "enum", options: ["a", "b"] }],
    });
    await fs.writeFile(path.join(good, "docker-compose.yml"), "services: {}\n", "utf8");

    // Duplicate id: must not shadow `good` nor steal its asset mapping.
    const duplicate = path.join(root, "zz-duplicate");
    await fs.ensureDir(duplicate);
    await fs.writeJson(path.join(duplicate, "template.json"), {
      id: "shared-id",
      title: "Duplicate",
    });
    await fs.writeFile(
      path.join(duplicate, "docker-compose.yml"),
      "services: {}\n",
      "utf8"
    );

    // `options` as a string turns `.includes` into a substring test.
    const badOptions = path.join(root, "bad-options");
    await fs.ensureDir(badOptions);
    await fs.writeJson(path.join(badOptions, "template.json"), {
      id: "bad-options",
      title: "Bad Options",
      parameters: [{ key: "MODE", label: "Mode", type: "enum", options: "prodpath" }],
    });
    await fs.writeFile(
      path.join(badOptions, "docker-compose.yml"),
      "services: {}\n",
      "utf8"
    );

    // A `type` outside the union used to fall through to an unvalidated value.
    const badType = path.join(root, "bad-type");
    await fs.ensureDir(badType);
    await fs.writeJson(path.join(badType, "template.json"), {
      id: "bad-type",
      title: "Bad Type",
      parameters: [{ key: "ANY", label: "Any", type: "raw" }],
    });
    await fs.writeFile(path.join(badType, "docker-compose.yml"), "services: {}\n", "utf8");

    process.env.DECKOS_TEMPLATES_DIR = root;
    const { templates } = await loadTemplatesModule();

    const listed = await templates.listTemplates({
      query: "",
      category: "",
      page: 1,
      pageSize: 50,
    });

    expect(listed.items.map((item) => item.id).sort()).toEqual(["shared-id"]);
    expect((await templates.getTemplate("shared-id")).title).toBe("Good");
    expect(await templates.getTemplateAssetPath("shared-id", "docker-compose.yml")).toContain(
      path.join("good", "docker-compose.yml")
    );
    await expect(templates.getTemplate("bad-options")).rejects.toThrow("Template not found");
    await expect(templates.getTemplate("bad-type")).rejects.toThrow("Template not found");
  });
});

/**
 * DOCK-8 caution 1: rewriting placeholder substitution to go through the YAML
 * document API could silently change the rendered output of any of the shipped
 * templates. This renders every one of them with its default parameter values
 * and asserts the result still parses and is semantically identical to what the
 * previous raw string-replace implementation produced.
 */
describe("shipped template rendering is unchanged", () => {
  const templatesDir = path.resolve(__dirname, "..", "..", "templates");

  /** The implementation this PR replaces. */
  function legacyRenderPlaceholders(
    template: string,
    values: Record<string, string>
  ): string {
    return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => values[key] ?? "");
  }

  function sampleValueFor(type: string): string {
    switch (type) {
      case "port":
        return "8123";
      case "number":
        return "42";
      case "path":
        return "./data";
      case "boolean":
        return "true";
      default:
        return "sample-value";
    }
  }

  test("every shipped template renders identically to the previous implementation", async () => {
    const { templates } = await loadTemplatesModule();
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });

    let compared = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const templateDir = path.join(templatesDir, entry.name);
      const jsonPath = path.join(templateDir, "template.json");
      const composePath = path.join(templateDir, "docker-compose.yml");
      if (!(await fs.pathExists(jsonPath)) || !(await fs.pathExists(composePath))) continue;

      const json = (await fs.readJson(jsonPath)) as {
        parameters?: Array<{ key: string; type: string; defaultValue?: string }>;
      };
      const composeTemplate = await fs.readFile(composePath, "utf-8");

      const values: Record<string, string> = {};
      for (const parameter of json.parameters ?? []) {
        values[parameter.key] = parameter.defaultValue?.trim()
          ? parameter.defaultValue
          : sampleValueFor(parameter.type);
      }

      const legacy = legacyRenderPlaceholders(composeTemplate, values);
      const rendered = templates.renderComposeTemplate(composeTemplate, values);

      expect(rendered, `${entry.name}: unresolved placeholders`).not.toMatch(
        /\{\{[A-Z0-9_]+\}\}/
      );
      expect(
        parse(rendered),
        `${entry.name}: rendered output differs semantically`
      ).toEqual(parse(legacy));
      compared++;
    }

    expect(compared).toBe(158);
  });
});
