import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifestPaths = [
  "package.json",
  "packages/client/package.json",
  "packages/server/package.json",
];

const inputVersion = String(process.argv[2] ?? "").trim();
if (!inputVersion) {
  throw new Error("Usage: node scripts/cut-release.mjs <version>");
}

const normalizedVersion = inputVersion.replace(/^v/, "");
const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (!semverPattern.test(normalizedVersion)) {
  throw new Error(`Invalid version "${inputVersion}"`);
}

const tagName = inputVersion.startsWith("v") ? inputVersion : `v${normalizedVersion}`;

const run = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false,
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });

const runCapture = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed`));
    });
  });

const gitStatus = await runCapture("git", ["status", "--porcelain"]);
if (gitStatus.trim()) {
  throw new Error("Working tree is not clean. Commit or stash existing changes first.");
}

for (const manifestPath of manifestPaths) {
  const absPath = join(repoRoot, manifestPath);
  const raw = await readFile(absPath, "utf-8");
  const parsed = JSON.parse(raw);
  parsed.version = normalizedVersion;
  await writeFile(absPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

await run("git", ["add", ...manifestPaths]);
await run("git", ["commit", "-m", `chore: cut ${normalizedVersion}`]);
await run("git", ["push"]);
await run("git", ["tag", tagName]);
await run("git", ["push", "origin", tagName]);

console.log(`Release cut: ${normalizedVersion} (${tagName})`);
