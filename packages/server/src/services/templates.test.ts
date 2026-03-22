import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
    apps: apps as any,
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

    const { templates, apps } = await loadTemplatesModule();
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

    expect(apps.createApp).toHaveBeenCalledTimes(1);
    const composeYaml = apps.createApp.mock.calls[0][4] as string;
    expect(composeYaml).toContain("9090:80");
    expect(composeYaml).toContain("MODE=prod");
    expect(composeYaml).not.toContain("{{");
  });
});
