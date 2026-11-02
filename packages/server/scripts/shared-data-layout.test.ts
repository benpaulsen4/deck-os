import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import fs from "fs-extra";
import { parse } from "yaml";
import { afterEach, describe, expect, test } from "vitest";
import {
  SHARED_DATA_APPS,
  SHARED_DATA_DEFAULT_SOURCE,
  SHARED_DATA_PARAMETER_DESCRIPTION,
  SHARED_DATA_TARGET,
} from "./shared-data-layout.js";

const execFileAsync = promisify(execFile);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptsDir, "..");
const shippedTemplatesDir = path.join(serverDir, "templates");

type ComposeVolume = { source?: string; target?: string };
type Compose = { services: Record<string, { volumes?: ComposeVolume[] }> };
type TemplateJson = {
  description: string;
  parameters: Array<{ key: string; defaultValue?: string; description?: string }>;
};

async function readTemplate(templatesDir: string, id: string) {
  const compose = parse(
    await fs.readFile(path.join(templatesDir, id, "docker-compose.yml"), "utf-8")
  ) as Compose;
  const json = (await fs.readJson(
    path.join(templatesDir, id, "template.json")
  )) as TemplateJson;
  return { compose, json };
}

function expectSharedDataLayout(
  id: string,
  { compose, json }: Awaited<ReturnType<typeof readTemplate>>
) {
  const volumes = Object.values(compose.services).flatMap((svc) => svc.volumes ?? []);
  const targets = volumes.map((volume) => volume.target);

  expect(targets.filter((target) => target === SHARED_DATA_TARGET)).toHaveLength(1);
  for (const replaced of SHARED_DATA_APPS[id].replacesTargets) {
    expect(targets).not.toContain(replaced);
  }

  const source = volumes.find((volume) => volume.target === SHARED_DATA_TARGET)?.source;
  const parameter = json.parameters.find((p) => source === `{{${p.key}}}`);
  expect(parameter?.defaultValue).toBe(SHARED_DATA_DEFAULT_SOURCE);
  expect(parameter?.description).toBe(SHARED_DATA_PARAMETER_DESCRIPTION);
  expect(json.description.endsWith(SHARED_DATA_APPS[id].guidance)).toBe(true);
}

describe("shared /data layout", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
  });

  test.each(Object.keys(SHARED_DATA_APPS))(
    "shipped %s template mounts one shared /data",
    async (id) => {
      expectSharedDataLayout(id, await readTemplate(shippedTemplatesDir, id));
    }
  );

  test("a re-import from upstream's split layout keeps the fix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "deckos-import-"));
    tempDirs.push(root);
    const outDir = path.join(root, "out");

    await fs.outputFile(
      path.join(root, "store", "Apps", "Sonarr", "docker-compose.yml"),
      `name: sonarr
services:
  sonarr:
    image: linuxserver/sonarr:latest
    ports:
      - target: 8989
        published: "8989"
        protocol: tcp
    volumes:
      - type: bind
        source: /DATA/AppData/$AppID/config
        target: /config
      - type: bind
        source: /DATA/Media/TV Shows
        target: /tv
      - type: bind
        source: /DATA/Downloads
        target: /downloads
`
    );
    await fs.outputJson(path.join(root, "store", "Apps", "Sonarr", "appfile.json"), {
      title: "Sonarr",
      overview: "A PVR.",
    });
    // The short volume syntax has to be handled too, and an app outside the
    // layout has to come through untouched.
    await fs.outputFile(
      path.join(root, "store", "Apps", "Radarr", "docker-compose.yml"),
      `services:
  radarr:
    image: linuxserver/radarr:latest
    volumes:
      - /DATA/AppData/$AppID/config:/config
      - /DATA/Media/Movies:/movies
      - /DATA/Downloads:/downloads
`
    );
    await fs.outputFile(
      path.join(root, "store", "Apps", "Plex", "docker-compose.yml"),
      `services:
  plex:
    image: linuxserver/plex:latest
    volumes:
      - type: bind
        source: /DATA/Media
        target: /Media
`
    );

    await execFileAsync(
      path.join(serverDir, "node_modules", ".bin", "tsx"),
      [
        path.join(scriptsDir, "import-casaos-templates.ts"),
        "--src",
        path.join(root, "store"),
        "--out",
        outDir,
      ],
      { cwd: serverDir }
    );

    const sonarr = await readTemplate(outDir, "sonarr");
    expectSharedDataLayout("sonarr", sonarr);
    expect(sonarr.json.description).toBe(`A PVR. ${SHARED_DATA_APPS.sonarr.guidance}`);

    const radarr = await readTemplate(outDir, "radarr");
    const radarrVolumes = radarr.compose.services.radarr.volumes as unknown as Array<
      string | ComposeVolume
    >;
    expect(radarrVolumes).toEqual([
      "{{VOLUME_RADARR__CONFIG}}:/config",
      { type: "bind", source: "{{VOLUME_RADARR__DATA}}", target: "/data" },
    ]);
    expect(radarr.json.parameters.map((p) => p.key)).toEqual([
      "VOLUME_RADARR__CONFIG",
      "VOLUME_RADARR__DATA",
    ]);
    expect(radarr.json.description).toBe(SHARED_DATA_APPS.radarr.guidance);

    const plex = await readTemplate(outDir, "plex");
    expect(plex.compose.services.plex.volumes?.map((v) => v.target)).toEqual(["/Media"]);
    expect(plex.json.parameters[0].defaultValue).toBe("./media");
    expect(plex.json.parameters[0].description).toBeUndefined();
  }, 30_000);
});
