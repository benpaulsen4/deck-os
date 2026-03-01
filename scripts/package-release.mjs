import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";

const execFile = promisify(execFileCb);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const rootPkgRaw = await readFile(join(repoRoot, "package.json"), "utf-8");
const rootPkg = JSON.parse(rootPkgRaw);
const version = String(rootPkg.version || "").trim();
if (!version) {
  throw new Error("package.json version missing");
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const platform = "linux";
const name = `deckos-${version}-${platform}-${arch}.tar.gz`;

const outDir = join(repoRoot, "dist", "release");
const stagingDir = join(outDir, `deckos-${version}`);
const tarPath = join(outDir, name);

await rm(outDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

const copy = async (srcRel, destRel) => {
  const src = join(repoRoot, srcRel);
  const dest = join(stagingDir, destRel);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
};

const serverDeploySrc = join(repoRoot, "dist", "server-deploy");
await access(join(serverDeploySrc, "dist", "index.js"));
await access(join(serverDeploySrc, "node_modules", "hono"));

const serverDeployDest = join(stagingDir, "packages", "server");
await rm(serverDeployDest, { recursive: true, force: true });
await mkdir(dirname(serverDeployDest), { recursive: true });
await rename(serverDeploySrc, serverDeployDest);

await copy("packages/client/dist", "packages/client/dist");

await writeFile(join(stagingDir, "VERSION"), `${version}\n`, "utf-8");

await execFile("tar", ["-czf", tarPath, "-C", outDir, `deckos-${version}`]);

console.log(tarPath);

