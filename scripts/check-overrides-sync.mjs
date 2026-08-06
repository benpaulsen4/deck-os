#!/usr/bin/env node
// Fails when package.json `pnpm.overrides` and pnpm-workspace.yaml `overrides`
// disagree.
//
// The two must be declared twice because pnpm 9 reads only the former and
// pnpm 10+ reads only the latter. Nothing but this check stops them drifting,
// and a drift is silent: an install on the other pnpm generation quietly
// resolves without the pins and reintroduces the advisories they suppress.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const pkgOverrides = pkg?.pnpm?.overrides ?? {};

// Minimal parser for the top-level `overrides:` block. Deliberately strict:
// anything it does not recognise is an error rather than a silent skip, so it
// can never pass by failing to see an entry.
function parseWorkspaceOverrides(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "overrides:");
  if (start === -1) {
    throw new Error("pnpm-workspace.yaml has no top-level `overrides:` key");
  }

  const result = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // A non-indented line ends the block.
    if (!/^\s/.test(line)) break;

    const match = /^ {2}(?:"([^"]+)"|([^:\s][^:]*?))\s*:\s*(?:"([^"]*)"|(\S+))\s*$/.exec(line);
    if (!match) {
      throw new Error(`Unparseable line in pnpm-workspace.yaml overrides: ${JSON.stringify(line)}`);
    }
    const key = match[1] ?? match[2];
    const value = match[3] ?? match[4];
    if (key in result) {
      throw new Error(`Duplicate override key in pnpm-workspace.yaml: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

const workspaceText = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf-8");
const workspaceOverrides = parseWorkspaceOverrides(workspaceText);

const keys = [...new Set([...Object.keys(pkgOverrides), ...Object.keys(workspaceOverrides)])].sort();
const problems = [];

for (const key of keys) {
  const inPkg = Object.prototype.hasOwnProperty.call(pkgOverrides, key);
  const inWorkspace = Object.prototype.hasOwnProperty.call(workspaceOverrides, key);

  if (!inWorkspace) {
    problems.push(`  ${key}: in package.json (${pkgOverrides[key]}) but missing from pnpm-workspace.yaml`);
  } else if (!inPkg) {
    problems.push(`  ${key}: in pnpm-workspace.yaml (${workspaceOverrides[key]}) but missing from package.json`);
  } else if (pkgOverrides[key] !== workspaceOverrides[key]) {
    problems.push(
      `  ${key}: package.json has "${pkgOverrides[key]}", pnpm-workspace.yaml has "${workspaceOverrides[key]}"`
    );
  }
}

if (problems.length > 0) {
  console.error("Dependency overrides are out of sync.\n");
  console.error(problems.join("\n"));
  console.error(
    "\npackage.json `pnpm.overrides` is read by pnpm 9; pnpm-workspace.yaml" +
      "\n`overrides` is read by pnpm 10+. Both must list the same entries."
  );
  process.exit(1);
}

console.log(`Dependency overrides are in sync (${keys.length} entries).`);
