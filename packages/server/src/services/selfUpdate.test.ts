import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const updatesMock = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  clearUpdateStatusCache: vi.fn(),
}));

// Only the network-facing and cache-facing parts of the updates service are
// mocked. The version parsing helpers are the real ones, because selfUpdate leans
// on them to reject hostile release tags.
vi.mock("./updates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./updates.js")>();
  return {
    ...actual,
    getUpdateStatus: updatesMock.getUpdateStatus,
    clearUpdateStatusCache: updatesMock.clearUpdateStatusCache,
  };
});

async function importSelfUpdate() {
  vi.resetModules();
  return await import("./selfUpdate.js");
}

/* ------------------------------------------------------------------ *
 * Real ed25519 key material, generated per run. Nothing is committed.
 * ------------------------------------------------------------------ */

function generateSigningKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const signing = generateSigningKeypair();
const otherSigning = generateSigningKeypair();

function signBytes(bytes: Buffer, key = signing.privateKey): Buffer {
  // ed25519 signs the message directly: the algorithm argument must be null.
  return cryptoSign(null, bytes, key);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Standard `sha256sum` output: "<64-hex>  <filename>". */
function buildSums(files: { name: string; body: Buffer }[]): Buffer {
  return Buffer.from(files.map((f) => `${sha256(f.body)}  ${f.name}\n`).join(""), "utf8");
}

/* ------------------------------------------------------------------ *
 * Real tar.gz fixtures, built byte by byte so hostile archives that no
 * sane tar would produce can be exercised too.
 * ------------------------------------------------------------------ */

type TarEntry = {
  name: string;
  type?: string;
  content?: string | Buffer;
  linkname?: string;
  /** Overrides the size written into the header (for the oversize test). */
  declaredSize?: number;
};

function octalField(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function buildTarHeader(opts: {
  name: string;
  size: number;
  type: string;
  linkname?: string;
}): Buffer {
  const block = Buffer.alloc(512);
  block.write(opts.name, 0, 100, "utf8");
  block.write(octalField(0o644, 8), 100, 8, "utf8");
  block.write(octalField(0, 8), 108, 8, "utf8");
  block.write(octalField(0, 8), 116, 8, "utf8");
  block.write(octalField(opts.size, 12), 124, 12, "utf8");
  block.write(octalField(Math.floor(Date.now() / 1000), 12), 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8"); // checksum is computed over spaces
  block.write(opts.type, 156, 1, "utf8");
  if (opts.linkname) block.write(opts.linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return block;
}

function padTo512(buffer: Buffer): Buffer {
  const remainder = buffer.length % 512;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(512 - remainder)]);
}

function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? "", "utf8");
    const type = entry.type ?? "0";

    if (entry.name.length > 100) {
      // GNU long-name extension, exactly as GNU tar emits it.
      const nameBytes = Buffer.concat([Buffer.from(entry.name, "utf8"), Buffer.alloc(1)]);
      parts.push(
        buildTarHeader({ name: "././@LongLink", size: nameBytes.length, type: "L" })
      );
      parts.push(padTo512(nameBytes));
    }

    parts.push(
      buildTarHeader({
        name: entry.name.slice(0, 100),
        size: entry.declaredSize ?? content.length,
        type,
        linkname: entry.linkname,
      })
    );
    if ((type === "0" || type === "7") && entry.declaredSize === undefined) {
      parts.push(padTo512(content));
    }
  }
  parts.push(Buffer.alloc(1024)); // two trailing zero blocks
  return Buffer.concat(parts);
}

const RELEASE_VERSION = "0.4.0";

function releaseEntries(version = RELEASE_VERSION, extra: TarEntry[] = []): TarEntry[] {
  const root = `deckos-${version}`;
  return [
    { name: `${root}/`, type: "5" },
    { name: `${root}/VERSION`, content: `${version}\n` },
    { name: `${root}/packages/`, type: "5" },
    { name: `${root}/packages/server/dist/index.js`, content: "console.log('deckos');\n" },
    { name: `${root}/packages/client/dist/index.html`, content: "<!doctype html>\n" },
    ...extra,
  ];
}

function buildReleaseTarball(version = RELEASE_VERSION, extra: TarEntry[] = []): Buffer {
  return gzipSync(buildTar(releaseEntries(version, extra)));
}

/**
 * The tar binary used for real extraction in the end-to-end tests. Git's GNU tar
 * on Windows reads `D:\...` as a remote host spec, so the bundled bsdtar is used
 * there; CI runs on Linux.
 */
function resolveSystemTar(): string | null {
  const candidates =
    process.platform === "win32"
      ? ["C:\\Windows\\System32\\tar.exe"]
      : ["/usr/bin/tar", "/bin/tar"];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const systemTar = resolveSystemTar();

/* ------------------------------------------------------------------ *
 * GitHub stub returning real Response objects with real bodies.
 * ------------------------------------------------------------------ */

type AssetSpec = { id: number; name: string; body: Buffer };
type FetchCall = { url: string; init: RequestInit | undefined };

function stubGithub(opts: {
  release: Record<string, unknown>;
  assets: AssetSpec[];
  requireToken?: boolean;
  /** Serve assets via a redirect to this origin instead of inline. */
  assetRedirectTo?: string;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorized = Boolean(headers.Authorization);

    if (opts.requireToken && !authorized && !url.includes("/download/")) {
      return new Response("private", { status: 404, statusText: "Not Found" });
    }
    if (url.includes("/releases/latest") || url.includes("/releases/tags/")) {
      return new Response(JSON.stringify(opts.release), { status: 200 });
    }

    const assetMatch = /\/releases\/assets\/(\d+)$/.exec(url);
    if (assetMatch) {
      const asset = opts.assets.find((a) => a.id === Number(assetMatch[1]));
      if (!asset) return new Response("no asset", { status: 404, statusText: "Not Found" });
      if (opts.assetRedirectTo) {
        return new Response(null, {
          status: 302,
          headers: { location: `${opts.assetRedirectTo}/download/${asset.id}` },
        });
      }
      return new Response(asset.body, { status: 200 });
    }

    const redirectMatch = /\/download\/(\d+)$/.exec(url);
    if (redirectMatch) {
      const asset = opts.assets.find((a) => a.id === Number(redirectMatch[1]));
      if (!asset) return new Response("no asset", { status: 404, statusText: "Not Found" });
      return new Response(asset.body, { status: 200 });
    }

    return new Response("unexpected", { status: 500, statusText: "Server Error" });
  };

  vi.stubGlobal("fetch", vi.fn(impl));
  return calls;
}

/** Builds a complete, correctly signed release plus its GitHub metadata. */
function buildSignedRelease(options?: {
  version?: string;
  signWith?: typeof signing.privateKey;
  sumsOverride?: Buffer;
  signatureOverride?: Buffer;
  omitSums?: boolean;
  omitSignature?: boolean;
  tagName?: string;
}) {
  const version = options?.version ?? RELEASE_VERSION;
  const tarName = `deckos-${version}-linux-x64.tar.gz`;
  const tarball = buildReleaseTarball(version);
  const sums = options?.sumsOverride ?? buildSums([{ name: tarName, body: tarball }]);
  const signature =
    options?.signatureOverride ?? signBytes(sums, options?.signWith ?? signing.privateKey);

  const assets: AssetSpec[] = [{ id: 10, name: tarName, body: tarball }];
  if (!options?.omitSums) assets.push({ id: 11, name: "SHA256SUMS", body: sums });
  if (!options?.omitSignature) {
    assets.push({ id: 12, name: "SHA256SUMS.sig", body: signature });
  }

  return {
    version,
    tarName,
    tarball,
    sums,
    signature,
    assets,
    release: {
      tag_name: options?.tagName ?? `v${version}`,
      draft: false,
      prerelease: false,
      assets: assets.map((a) => ({ id: a.id, name: a.name })),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Temp install root
 * ------------------------------------------------------------------ */

let workspace = "";
let installRoot = "";
let releasesDir = "";
let currentLink = "";

async function seedRelease(version: string, mtime?: Date) {
  const dir = join(releasesDir, version, "packages", "server", "dist");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.js"), `// ${version}\n`, "utf8");
  if (mtime) await utimes(join(releasesDir, version), mtime, mtime);
  return join(releasesDir, version);
}

async function listReleases(): Promise<string[]> {
  const entries = await readdir(releasesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe("selfUpdate service", () => {
  const originalPlatform = process.platform;
  const envBackup = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
    workspace = await mkdtemp(join(tmpdir(), "deckos-selfupdate-"));
    installRoot = join(workspace, "opt", "deckos");
    releasesDir = join(installRoot, "releases");
    currentLink = join(installRoot, "current");
    await mkdir(releasesDir, { recursive: true });

    process.env.DECKOS_GITHUB_OWNER = "deckos";
    process.env.DECKOS_GITHUB_REPO = "deckos";
    process.env.DECKOS_INSTALL_ROOT = installRoot;
    process.env.DECKOS_UPDATE_TMP_DIR = join(workspace, "tmp");
    delete process.env.DECKOS_GITHUB_TOKEN;
    delete process.env.DECKOS_GITHUB_API_BASE;

    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: true,
      error: null,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    process.env = { ...envBackup };
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- *
   * UPD-1: signature verification
   * ---------------------------------------------------------------- */

  describe("release signature verification", () => {
    const sumsFixture = () =>
      buildSums([{ name: "deckos.tar.gz", body: Buffer.from("payload") }]);

    test("accepts a genuine ed25519 signature over SHA256SUMS", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const sums = sumsFixture();

      expect(() =>
        verifyReleaseSignature(sums, signBytes(sums), signing.publicKeyPem)
      ).not.toThrow();
    });

    test("rejects a genuinely invalid signature when the manifest is tampered with", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const sums = sumsFixture();
      const signature = signBytes(sums);
      const tampered = Buffer.from(sums.toString("utf8").replace(/^./, "0"), "utf8");

      expect(() =>
        verifyReleaseSignature(tampered, signature, signing.publicKeyPem)
      ).toThrow(/not signed by the DeckOS release key/);
    });

    test("rejects a signature made with a different key", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const sums = sumsFixture();

      expect(() =>
        verifyReleaseSignature(
          sums,
          signBytes(sums, otherSigning.privateKey),
          signing.publicKeyPem
        )
      ).toThrow(/not signed by the DeckOS release key/);
    });

    test("requires a raw 64-byte signature, not base64", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const sums = sumsFixture();
      const base64 = Buffer.from(signBytes(sums).toString("base64"), "utf8");

      expect(() => verifyReleaseSignature(sums, base64, signing.publicKeyPem)).toThrow(
        /raw 64-byte ed25519 signature/
      );
    });

    test("refuses to verify while the public key is still the sentinel", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const { RELEASE_PUBLIC_KEY_PEM } = await import("../lib/releaseKey.js");
      const sums = sumsFixture();

      expect(RELEASE_PUBLIC_KEY_PEM).toBe("REPLACE_WITH_DECKOS_RELEASE_PUBLIC_KEY");
      expect(() =>
        verifyReleaseSignature(sums, signBytes(sums), RELEASE_PUBLIC_KEY_PEM)
      ).toThrow(/still the placeholder/);
    });

    test("rejects a public key that is not ed25519", async () => {
      const { verifyReleaseSignature } = await importSelfUpdate();
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const sums = sumsFixture();

      expect(() =>
        verifyReleaseSignature(
          sums,
          signBytes(sums),
          rsa.publicKey.export({ type: "spki", format: "pem" }).toString()
        )
      ).toThrow(/must be ed25519/);
    });
  });

  describe("SHA256SUMS parsing", () => {
    test("parses standard sha256sum output", async () => {
      const { parseSha256Sums } = await importSelfUpdate();
      const body = Buffer.from("hello");
      const entries = parseSha256Sums(`${sha256(body)}  deckos-0.4.0-linux-x64.tar.gz\n`);

      expect(entries.get("deckos-0.4.0-linux-x64.tar.gz")).toBe(sha256(body));
    });

    test("rejects unparseable lines and conflicting duplicates", async () => {
      const { parseSha256Sums } = await importSelfUpdate();
      expect(() => parseSha256Sums("not a checksum line\n")).toThrow(/unparseable line/);
      expect(() =>
        parseSha256Sums(`${"a".repeat(64)}  file\n${"b".repeat(64)}  file\n`)
      ).toThrow(/conflicting digests/);
    });
  });

  /* ---------------------------------------------------------------- *
   * UPD-6: archive member validation
   * ---------------------------------------------------------------- */

  describe("release archive inspection", () => {
    async function inspectBuffer(tarball: Buffer) {
      const { inspectReleaseArchive } = await importSelfUpdate();
      const file = join(workspace, `${randomUUID()}.tar.gz`);
      await writeFile(file, tarball);
      return await inspectReleaseArchive(file);
    }

    test("accepts a well-formed release archive", async () => {
      const summary = await inspectBuffer(buildReleaseTarball());
      expect(summary.root).toBe(`deckos-${RELEASE_VERSION}`);
      expect(summary.memberCount).toBeGreaterThan(0);
      expect(summary.uncompressedBytes).toBeGreaterThan(0);
    });

    test.skipIf(!systemTar)(
      "accepts an archive produced by the system tar, including long paths",
      async () => {
        const stage = join(workspace, "stage");
        const root = `deckos-${RELEASE_VERSION}`;
        const deep = join(
          stage,
          root,
          "packages",
          "server",
          "node_modules",
          "a".repeat(60),
          "b".repeat(60),
          "nested"
        );
        await mkdir(deep, { recursive: true });
        await writeFile(join(deep, "long-name-file.js"), "// deep\n", "utf8");
        const distDir = join(stage, root, "packages", "server", "dist");
        await mkdir(distDir, { recursive: true });
        await writeFile(join(distDir, "index.js"), "console.log(1)\n", "utf8");
        await writeFile(join(stage, root, "VERSION"), `${RELEASE_VERSION}\n`, "utf8");

        const tarPath = join(workspace, "system.tar.gz");
        execFileSync(systemTar as string, ["-czf", tarPath, "-C", stage, root]);

        const { inspectReleaseArchive } = await importSelfUpdate();
        expect((await inspectReleaseArchive(tarPath)).root).toBe(root);
      }
    );

    test("rejects a member that traverses out of the archive root", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            { name: `deckos-${RELEASE_VERSION}/../../etc/cron.d/evil`, content: "boom" },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/escapes the archive root/);
    });

    test("rejects an absolute member path", async () => {
      const tarball = gzipSync(
        buildTar(releaseEntries(RELEASE_VERSION, [{ name: "/etc/passwd", content: "x" }]))
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/absolute path/);
    });

    test("rejects a symlink pointing outside the extraction directory", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            {
              name: `deckos-${RELEASE_VERSION}/packages/escape`,
              type: "2",
              linkname: "../../../../etc",
            },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/symlinks outside/);
    });

    test("rejects a symlink to an absolute path", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            {
              name: `deckos-${RELEASE_VERSION}/packages/escape`,
              type: "2",
              linkname: "/etc/shadow",
            },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/links to an absolute path/);
    });

    test("accepts an in-tree relative symlink", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            {
              name: `deckos-${RELEASE_VERSION}/packages/server/node_modules/.bin/tsc`,
              type: "2",
              linkname: "../typescript/bin/tsc",
            },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).resolves.toMatchObject({
        root: `deckos-${RELEASE_VERSION}`,
      });
    });

    test("rejects device and fifo members", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            { name: `deckos-${RELEASE_VERSION}/packages/dev-node`, type: "3" },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/unsupported tar entry type/);
    });

    test("rejects more than one top-level directory", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            { name: "other-1.0.0/packages/thing.js", content: "x" },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(
        /more than one top-level directory/
      );
    });

    test("rejects an unexpected archive root name", async () => {
      const tarball = gzipSync(
        buildTar([{ name: "evil/packages/server/dist/index.js", content: "x" }])
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(
        /unexpected top-level directory/
      );
    });

    test("rejects an unexpected top-level entry inside the archive", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            { name: `deckos-${RELEASE_VERSION}/etc/passwd`, content: "x" },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/unexpected top-level entry/);
    });

    test("rejects an archive missing the server build output", async () => {
      const tarball = gzipSync(
        buildTar([
          { name: `deckos-${RELEASE_VERSION}/`, type: "5" },
          { name: `deckos-${RELEASE_VERSION}/VERSION`, content: "0.4.0\n" },
        ])
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(
        /missing packages\/server\/dist\/index\.js/
      );
    });

    test("rejects a member larger than the per-member ceiling", async () => {
      const tarball = gzipSync(
        buildTar(
          releaseEntries(RELEASE_VERSION, [
            {
              name: `deckos-${RELEASE_VERSION}/packages/huge.bin`,
              declaredSize: 300 * 1024 * 1024,
            },
          ])
        )
      );
      await expect(inspectBuffer(tarball)).rejects.toThrow(/larger than the/);
    });

    test("rejects an HTML error page served in place of a tarball", async () => {
      await expect(
        inspectBuffer(Buffer.from("<html><body>404</body></html>", "utf8"))
      ).rejects.toThrow();
    });

    test("rejects a truncated archive", async () => {
      const raw = buildTar(releaseEntries());
      await expect(inspectBuffer(gzipSync(raw.subarray(0, 512 + 256)))).rejects.toThrow();
    });

    test("rejects a tar stream with a corrupted header checksum", async () => {
      const raw = buildTar(releaseEntries());
      raw[150] = 0x39; // scribble on the stored checksum
      await expect(inspectBuffer(gzipSync(raw))).rejects.toThrow(/bad header checksum/);
    });
  });

  /* ---------------------------------------------------------------- *
   * applyUpdate guards
   * ---------------------------------------------------------------- */

  test("rejects self-update on non-linux platforms", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { applyUpdate } = await importSelfUpdate();

    await expect(applyUpdate()).rejects.toThrow("Self-update is only supported on Linux");
  });

  test("rejects draft releases", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const signed = buildSignedRelease();
    stubGithub({ release: { ...signed.release, draft: true }, assets: signed.assets });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow("Cannot install a draft release");
  });

  test("rejects prereleases", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const signed = buildSignedRelease();
    stubGithub({ release: { ...signed.release, prerelease: true }, assets: signed.assets });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow("Cannot install a prerelease");
  });

  test("throws when no update is available for an implicit latest install", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: true,
      updateAvailable: false,
      error: null,
    });
    const signed = buildSignedRelease();
    stubGithub({ release: signed.release, assets: signed.assets });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow("No update available");
  });

  test("throws when the release has no tarball asset", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const calls = stubGithub({
      release: {
        tag_name: "v0.5.0",
        draft: false,
        prerelease: false,
        assets: [{ id: 100, name: "notes.txt" }],
      },
      assets: [],
    });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate("0.5.0")).rejects.toThrow("No .tar.gz release asset found");
    expect(calls[0]?.url).toContain("/releases/tags/v0.5.0");
  });

  test("prevents concurrent update executions", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    let resolveStatus: ((value: unknown) => void) | undefined;
    updatesMock.getUpdateStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve as (value: unknown) => void;
        })
    );

    const { applyUpdate } = await importSelfUpdate();
    const first = applyUpdate();
    await Promise.resolve();

    await expect(applyUpdate()).rejects.toThrow("Update already in progress");

    resolveStatus?.({ enabled: false, updateAvailable: false, error: "Updates disabled" });
    await expect(first).rejects.toThrow("Updates disabled");
  });

  test("releases a wedged in-progress lock once the watchdog window elapses", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // A status check that never settles. The old code left updateInProgress true
    // forever, so every later attempt failed until the process restarted.
    updatesMock.getUpdateStatus.mockImplementation(() => new Promise(() => undefined));

    const { applyUpdate } = await importSelfUpdate();
    void applyUpdate().catch(() => undefined);
    await Promise.resolve();

    await expect(applyUpdate()).rejects.toThrow("Update already in progress");

    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    updatesMock.getUpdateStatus.mockResolvedValue({
      enabled: false,
      updateAvailable: false,
      error: "Updates disabled",
    });
    await expect(applyUpdate()).rejects.toThrow("Updates disabled");
  });

  /* ---------------------------------------------------------------- *
   * UPD-2: hostile release tags
   * ---------------------------------------------------------------- */

  test("refuses a release tag that would traverse out of the releases directory", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const victim = join(workspace, "opt", "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep.txt"), "precious", "utf8");

    const signed = buildSignedRelease({ tagName: "v../../victim" });
    stubGithub({ release: signed.release, assets: signed.assets });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate()).rejects.toThrow(/not a valid semver version/);
    // Nothing was deleted: the old code handed this straight to rm -rf.
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });

  test("refuses an explicitly requested version that is not semver", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const signed = buildSignedRelease();
    const calls = stubGithub({ release: signed.release, assets: signed.assets });

    const { applyUpdate } = await importSelfUpdate();
    await expect(applyUpdate("../../../etc")).rejects.toThrow(/not a valid semver version/);
    expect(calls).toHaveLength(0); // rejected before any request
  });

  /* ---------------------------------------------------------------- *
   * End to end against a real temp install root
   * ---------------------------------------------------------------- */

  describe("applyUpdate end to end", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux" });
    });

    async function runUpdate(
      overrides?: { publicKeyPem?: string; tarBinary?: string }
    ) {
      const { applyUpdate } = await importSelfUpdate();
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      // Only setTimeout is faked, so the restart timer never fires and real
      // filesystem work is untouched.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        return await applyUpdate(undefined, {
          publicKeyPem: overrides?.publicKeyPem ?? signing.publicKeyPem,
          tarBinary: overrides?.tarBinary ?? systemTar ?? undefined,
        });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }

    test.skipIf(!systemTar)(
      "installs a correctly signed release and repoints current",
      async () => {
        await seedRelease("0.3.0");
        await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

        const signed = buildSignedRelease();
        stubGithub({ release: signed.release, assets: signed.assets });

        const result = await runUpdate();

        expect(result).toEqual({ targetVersion: "0.4.0", restarting: true });
        expect(
          existsSync(join(releasesDir, "0.4.0", "packages", "server", "dist", "index.js"))
        ).toBe(true);
        expect(await readlink(currentLink)).toBe(join(releasesDir, "0.4.0"));
        expect(updatesMock.clearUpdateStatusCache).toHaveBeenCalled();
      }
    );

    test.skipIf(!systemTar)(
      "refuses to install when the signature does not match the manifest",
      async () => {
        await seedRelease("0.3.0");
        await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

        // A real signature, but over a manifest that is not the one served.
        const decoy = buildSums([{ name: "other", body: Buffer.from("other") }]);
        const signed = buildSignedRelease({ signatureOverride: signBytes(decoy) });
        stubGithub({ release: signed.release, assets: signed.assets });

        await expect(runUpdate()).rejects.toThrow(/not signed by the DeckOS release key/);
        expect(existsSync(join(releasesDir, "0.4.0"))).toBe(false);
        expect(await readlink(currentLink)).toBe(join(releasesDir, "0.3.0"));
      }
    );

    test.skipIf(!systemTar)(
      "refuses to install when the tarball does not match the signed digest",
      async () => {
        await seedRelease("0.3.0");
        await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

        // Manifest and signature agree, but the served tarball is swapped for a
        // different, still well-formed archive.
        const signed = buildSignedRelease();
        const swapped = signed.assets.map((a) =>
          a.name.endsWith(".tar.gz")
            ? {
                ...a,
                body: buildReleaseTarball(RELEASE_VERSION, [
                  {
                    name: `deckos-${RELEASE_VERSION}/packages/extra.js`,
                    content: "malware",
                  },
                ]),
              }
            : a
        );
        stubGithub({ release: signed.release, assets: swapped });

        await expect(runUpdate()).rejects.toThrow(/checksum mismatch/);
        expect(existsSync(join(releasesDir, "0.4.0"))).toBe(false);
        expect(await readlink(currentLink)).toBe(join(releasesDir, "0.3.0"));
      }
    );

    test("refuses a release that ships no SHA256SUMS", async () => {
      const signed = buildSignedRelease({ omitSums: true });
      stubGithub({ release: signed.release, assets: signed.assets });

      await expect(runUpdate()).rejects.toThrow(/missing the "SHA256SUMS" asset/);
      expect(existsSync(join(releasesDir, "0.4.0"))).toBe(false);
    });

    test("refuses a release that ships no SHA256SUMS.sig", async () => {
      const signed = buildSignedRelease({ omitSignature: true });
      stubGithub({ release: signed.release, assets: signed.assets });

      await expect(runUpdate()).rejects.toThrow(/missing the "SHA256SUMS\.sig" asset/);
    });

    test("refuses to install anything while the signing key is the sentinel", async () => {
      const signed = buildSignedRelease();
      const calls = stubGithub({ release: signed.release, assets: signed.assets });

      const { applyUpdate } = await importSelfUpdate();
      await expect(applyUpdate()).rejects.toThrow(/still the placeholder/);
      // Metadata only: no asset was downloaded and nothing was written.
      expect(calls.every((c) => !/\/releases\/assets\//.test(c.url))).toBe(true);
      expect(existsSync(join(releasesDir, "0.4.0"))).toBe(false);
    });

    test.skipIf(!systemTar)(
      "rejects a manifest that does not list the downloaded asset",
      async () => {
        const sums = buildSums([
          { name: "some-other-file.tar.gz", body: Buffer.from("x") },
        ]);
        const signed = buildSignedRelease({ sumsOverride: sums });
        stubGithub({ release: signed.release, assets: signed.assets });

        await expect(runUpdate()).rejects.toThrow(/does not list/);
      }
    );

    test("rejects an oversized SHA256SUMS asset", async () => {
      const signed = buildSignedRelease({
        sumsOverride: Buffer.alloc(2 * 1024 * 1024, 0x41),
      });
      stubGithub({ release: signed.release, assets: signed.assets });

      await expect(runUpdate()).rejects.toThrow(/download limit/);
    });

    test("passes an abort signal to every request", async () => {
      const signed = buildSignedRelease();
      const calls = stubGithub({ release: signed.release, assets: signed.assets });

      await runUpdate().catch(() => undefined);

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    test("never replays the Authorization header to a redirect target", async () => {
      process.env.DECKOS_GITHUB_TOKEN = "secret-token";
      const signed = buildSignedRelease();
      const calls = stubGithub({
        release: signed.release,
        assets: signed.assets,
        requireToken: true,
        assetRedirectTo: "https://objects.example.test",
      });

      await runUpdate().catch(() => undefined);

      const redirected = calls.filter((c) =>
        c.url.startsWith("https://objects.example.test")
      );
      expect(redirected.length).toBeGreaterThan(0);
      for (const call of redirected) {
        const headers = (call.init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
      }
      // The credential was still used against the configured API base.
      const authed = calls.filter((c) => {
        const headers = (c.init?.headers ?? {}) as Record<string, string>;
        return headers.Authorization === "Bearer secret-token";
      });
      expect(authed.length).toBeGreaterThan(0);
    });

    /* -------------------------------------------------------------- *
     * UPD-7: stale current symlink
     * -------------------------------------------------------------- */

    test("returns without restarting when the target release is already live", async () => {
      await seedRelease("0.4.0");
      await symlink(join(releasesDir, "0.4.0"), currentLink, "dir");

      const signed = buildSignedRelease();
      stubGithub({ release: signed.release, assets: signed.assets });

      expect(await runUpdate()).toEqual({ targetVersion: "0.4.0", restarting: false });
    });

    test("re-links and restarts when the target is installed but current points elsewhere", async () => {
      // Exactly the post-manual-rollback state: 0.4.0 is on disk, 0.3.0 is live.
      await seedRelease("0.4.0");
      await seedRelease("0.3.0");
      await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

      const signed = buildSignedRelease();
      stubGithub({ release: signed.release, assets: signed.assets });

      const result = await runUpdate();

      expect(result).toEqual({ targetVersion: "0.4.0", restarting: true });
      expect(await readlink(currentLink)).toBe(join(releasesDir, "0.4.0"));
      expect(updatesMock.clearUpdateStatusCache).toHaveBeenCalled();
    });

    /* -------------------------------------------------------------- *
     * UPD-3: prune safety
     * -------------------------------------------------------------- */

    test.skipIf(!systemTar)(
      "keeps recent releases and never prunes the live one",
      async () => {
        await seedRelease("0.1.0", new Date(Date.now() - 4_000_000));
        await seedRelease("0.2.0", new Date(Date.now() - 3_000_000));
        await seedRelease("0.3.0", new Date(Date.now() - 2_000_000));
        await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

        const signed = buildSignedRelease();
        stubGithub({ release: signed.release, assets: signed.assets });
        await runUpdate();

        const remaining = await listReleases();
        expect(remaining).toContain("0.4.0");
        expect(remaining).toContain("0.3.0"); // rollback target
        expect(remaining).toContain("0.2.0");
        expect(remaining).not.toContain("0.1.0");
      }
    );

    test.skipIf(!systemTar)(
      "does not wipe every rollback target when current cannot be resolved",
      async () => {
        await seedRelease("0.1.0", new Date(Date.now() - 4_000_000));
        await seedRelease("0.2.0", new Date(Date.now() - 3_000_000));
        await seedRelease("0.3.0", new Date(Date.now() - 2_000_000));
        // A symlink pointing outside the releases dir: readlink succeeds but the
        // old code treated this as "no previous version" and deleted everything
        // except the new release.
        await symlink(join(workspace, "does-not-exist"), currentLink, "dir");

        const signed = buildSignedRelease();
        stubGithub({ release: signed.release, assets: signed.assets });
        await runUpdate();

        const remaining = await listReleases();
        expect(remaining).toContain("0.4.0");
        expect(remaining).toContain("0.3.0");
        expect(remaining).toContain("0.2.0");
      }
    );

    test.skipIf(!systemTar)(
      "replaces a half-installed release directory and leaves no temp dir behind",
      async () => {
        await mkdir(join(releasesDir, "0.4.0", "packages"), { recursive: true });
        await seedRelease("0.3.0");
        await symlink(join(releasesDir, "0.3.0"), currentLink, "dir");

        const signed = buildSignedRelease();
        stubGithub({ release: signed.release, assets: signed.assets });
        const result = await runUpdate();

        expect(result.restarting).toBe(true);
        expect(
          existsSync(join(releasesDir, "0.4.0", "packages", "server", "dist", "index.js"))
        ).toBe(true);
        expect(existsSync(join(releasesDir, "0.4.0", "VERSION"))).toBe(true);
        expect(
          existsSync(join(releasesDir, "0.4.0", "packages", "client", "dist", "index.html"))
        ).toBe(true);
        expect(existsSync(join(releasesDir, "0.4.0.tmp"))).toBe(false);
      }
    );

    test("fails cleanly when no tar binary can be resolved from an absolute path", async () => {
      const signed = buildSignedRelease();
      stubGithub({ release: signed.release, assets: signed.assets });

      await expect(
        runUpdate({ tarBinary: join(workspace, "no-such-tar") })
      ).rejects.toThrow(/Unable to locate the tar binary/);
    });
  });

  /* ---------------------------------------------------------------- *
   * UPD-3: rollback
   * ---------------------------------------------------------------- */

  describe("rollbackToPreviousRelease", () => {
    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux" });
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    });

    async function runRollback(version?: string) {
      const { rollbackToPreviousRelease } = await importSelfUpdate();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        return await rollbackToPreviousRelease(version);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    }

    test("repoints current at the most recently installed other release", async () => {
      await seedRelease("0.2.0", new Date(Date.now() - 4_000_000));
      await seedRelease("0.3.0", new Date(Date.now() - 2_000_000));
      await seedRelease("0.4.0", new Date(Date.now() - 1_000_000));
      await symlink(join(releasesDir, "0.4.0"), currentLink, "dir");

      expect(await runRollback()).toEqual({ targetVersion: "0.3.0", restarting: true });
      expect(readlinkSync(currentLink)).toBe(join(releasesDir, "0.3.0"));
      expect(lstatSync(currentLink).isSymbolicLink()).toBe(true);
    });

    test("rolls back to an explicitly requested version", async () => {
      await seedRelease("0.2.0");
      await seedRelease("0.4.0");
      await symlink(join(releasesDir, "0.4.0"), currentLink, "dir");

      expect(await runRollback("0.2.0")).toEqual({
        targetVersion: "0.2.0",
        restarting: true,
      });
      expect(readlinkSync(currentLink)).toBe(join(releasesDir, "0.2.0"));
    });

    test("refuses a traversal version and an uninstalled version", async () => {
      await seedRelease("0.4.0");
      await symlink(join(releasesDir, "0.4.0"), currentLink, "dir");

      await expect(runRollback("../../etc")).rejects.toThrow(/not a valid semver version/);
      await expect(runRollback("9.9.9")).rejects.toThrow(/is not installed/);
    });

    test("errors when there is nothing to roll back to", async () => {
      await seedRelease("0.4.0");
      await symlink(join(releasesDir, "0.4.0"), currentLink, "dir");

      await expect(runRollback()).rejects.toThrow(/No other installed release/);
    });
  });
});
