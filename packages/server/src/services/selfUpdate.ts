import { createReadStream, createWriteStream } from "node:fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clearUpdateStatusCache,
  getUpdateStatus,
  isValidReleaseVersion,
  normalizeVersion,
} from "./updates.js";
import {
  createGithubApiError,
  requestGithubRelease,
  requestGithubReleaseAsset,
} from "./githubReleaseApi.js";
import { RELEASE_PUBLIC_KEY_PEM, assertReleaseKeyConfigured } from "../lib/releaseKey.js";

type GithubReleaseAsset = {
  id: number;
  name: string;
};

type GithubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubReleaseAsset[];
};

type ApplyUpdateResult = {
  targetVersion: string;
  restarting: boolean;
};

/**
 * Internal seams, used only by the tests so they can run the real pipeline against
 * a real temp directory and a real signing key. Never populated from request input
 * or from the environment.
 */
export type SelfUpdateOverrides = {
  /** ed25519 public key (PEM SPKI) to verify `SHA256SUMS.sig` against. */
  publicKeyPem?: string;
  /** Absolute path to the `tar` binary. */
  tarBinary?: string;
};

const execFile = promisify(execFileCb);

/** Signed manifest assets. Names are exact and case-sensitive. */
export const SUMS_ASSET_NAME = "SHA256SUMS";
export const SIGNATURE_ASSET_NAME = "SHA256SUMS.sig";

const ED25519_SIGNATURE_BYTES = 64;

/** Download ceilings. Without these a drip-feeding server fills the temp dir. */
const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;

/** Archive ceilings, enforced before a single byte is extracted. */
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_ARCHIVE_METADATA_BYTES = 64 * 1024;

const TAR_BLOCK = 512;

/**
 * Top-level entries a release tarball may contain, once the `deckos-<version>/`
 * wrapper is stripped. Keep in sync with `scripts/package-release.mjs`: adding a
 * new top-level path to the tarball without adding it here makes the updater
 * refuse the release.
 */
const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  "packages",
  "VERSION",
  "LICENSE",
  "README.md",
  "docs",
]);

/**
 * Archive root directory name.
 *
 * The prerelease and build suffixes are two separate optional groups rather than
 * one repeated `(?:[-+]...)*`. In the repeated form `-` belonged to both the
 * introducer class and the body class, so a name such as `deckos-0.0.0+------`
 * could be partitioned exponentially many ways and would hang the event loop.
 * This name arrives from the release channel that UPD-1 exists to distrust, so
 * the pattern must be linear: every quantifier runs over a single class, and `+`
 * is excluded from the body classes so the split point is unambiguous.
 */
const ARCHIVE_ROOT_RE =
  /^deckos-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const SERVER_ENTRY_PATH = "packages/server/dist/index.js";

/**
 * `tar` is resolved from absolute paths only. The systemd unit sets no PATH, and a
 * PATH lookup would let anything writable by the `deckos` user (a member of the
 * `docker` group) take over extraction.
 */
const TAR_BINARY_CANDIDATES = ["/usr/bin/tar", "/bin/tar"];

const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_MAX_OUTPUT_BYTES = 1024 * 1024;
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** How many releases to retain on disk, rollback targets included. */
const KEEP_RELEASES = 3;

/**
 * Watchdog for the in-progress flag. An update that somehow neither resolves nor
 * rejects must not wedge the updater until the next restart.
 */
const UPDATE_LOCK_MAX_AGE_MS = 30 * 60_000;

/** Leftover `<version>.tmp` extraction dirs are only reaped once they are cold. */
const STALE_TMP_DIR_AGE_MS = 60 * 60_000;

let updateInProgress = false;
let updateStartedAt = 0;
let lockWatchdog: NodeJS.Timeout | null = null;

function acquireUpdateLock(): void {
  if (updateInProgress && Date.now() - updateStartedAt < UPDATE_LOCK_MAX_AGE_MS) {
    throw new Error("Update already in progress");
  }
  updateInProgress = true;
  updateStartedAt = Date.now();
  if (lockWatchdog) clearTimeout(lockWatchdog);
  lockWatchdog = setTimeout(() => {
    updateInProgress = false;
    lockWatchdog = null;
  }, UPDATE_LOCK_MAX_AGE_MS);
  lockWatchdog.unref?.();
}

function releaseUpdateLock(): void {
  updateInProgress = false;
  if (lockWatchdog) {
    clearTimeout(lockWatchdog);
    lockWatchdog = null;
  }
}

function getInstallRoot(): string {
  return (process.env.DECKOS_INSTALL_ROOT?.trim() || "/opt/deckos").replace(/\/+$/, "");
}

function getUpdateTmpRoot(): string {
  return (process.env.DECKOS_UPDATE_TMP_DIR?.trim() || tmpdir()).replace(/\/+$/, "");
}

/** Renders untrusted text safely for an error message shown in the panel. */
function safeLabel(value: string, limit = 120): string {
  const collapsed = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** Owner read/write/execute. */
const OWNER_RWX = 0o700;

/**
 * Ensures every directory in a tree is traversable and writable by its owner.
 *
 * A tar member carries its own mode, and `--no-same-permissions` does not rescue
 * us: for a non-root user it means "apply the umask to the archive's mode", and
 * `0555 & ~022` is still `0555`. A release that ships a directory without owner
 * write cannot have entries unlinked inside it afterwards, and one without owner
 * execute cannot even be traversed — which breaks the post-extract marker check,
 * the replace step, later pruning, and rollback. `fs.rm({ force: true })` does not
 * chmod around it.
 *
 * Modes are therefore normalised after extraction rather than trusted. Directories
 * are chmod-ed top down so each one is traversable before it is read. Files are
 * left alone: their modes do not block replacing the tree.
 */
async function ensureTreeTraversable(root: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch {
    return;
  }
  if (!stats.isDirectory()) return;

  if ((stats.mode & OWNER_RWX) !== OWNER_RWX) {
    try {
      await chmod(root, stats.mode | OWNER_RWX);
    } catch {
      // Best effort: carry on and let the caller surface the real failure.
    }
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    // `isDirectory` reflects lstat, so symlinked directories are not followed.
    if (entry.isDirectory()) {
      await ensureTreeTraversable(join(root, entry.name));
    }
  }
}

/**
 * Removes a directory tree, restoring owner access and retrying if the first
 * attempt is refused because of a directory mode inside it.
 */
async function removeTree(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
    await ensureTreeTraversable(target);
    await rm(target, { recursive: true, force: true });
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isWithinPath(parentPath: string, childPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Turns a release version into a directory under `releasesDir`.
 *
 * `tag_name` comes straight from the API response, so it is treated as untrusted:
 * a tag such as `v../../../var/lib/deckos` previously became the argument to
 * `rm -rf`. The version must be strict semver (which cannot contain a path
 * separator), and the resulting path must still be a direct child of the releases
 * directory.
 */
function resolveReleaseDir(releasesDir: string, version: string): string {
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `Refusing to act on release version "${safeLabel(version)}": not a valid semver version`
    );
  }
  const targetDir = join(releasesDir, version);
  if (
    !isWithinPath(releasesDir, targetDir) ||
    resolve(dirname(targetDir)) !== resolve(releasesDir) ||
    basename(targetDir) !== version
  ) {
    throw new Error(
      `Refusing to act on release version "${safeLabel(version)}": resolved outside the releases directory`
    );
  }
  return targetDir;
}

async function fetchReleaseByTag(tag: string): Promise<GithubRelease> {
  const { response, tokenConfigured } = await requestGithubRelease(
    `releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    throw await createGithubApiError(response, tokenConfigured);
  }
  return (await response.json()) as GithubRelease;
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const { response, tokenConfigured } = await requestGithubRelease("releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await createGithubApiError(response, tokenConfigured);
  }
  return (await response.json()) as GithubRelease;
}

async function openAssetStream(
  assetId: number,
  maxBytes: number
): Promise<AsyncIterable<Uint8Array>> {
  const { response, tokenConfigured } = await requestGithubReleaseAsset(assetId, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw await createGithubApiError(response, tokenConfigured);
  }
  const declared = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      `Release asset is larger than the ${maxBytes} byte limit (server declared ${declared} bytes)`
    );
  }
  return response.body as unknown as AsyncIterable<Uint8Array>;
}

/** Streams an asset to disk, aborting the moment it exceeds `maxBytes`. */
async function downloadAssetToFile(
  assetId: number,
  destPath: string,
  maxBytes: number
): Promise<number> {
  const source = await openAssetStream(assetId, maxBytes);
  let total = 0;
  await pipeline(
    source,
    async function* cap(chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(`Release asset exceeded the ${maxBytes} byte download limit`);
        }
        yield chunk;
      }
    },
    createWriteStream(destPath)
  );
  return total;
}

/** Buffers a small asset (the manifest and its signature) with a hard cap. */
async function downloadAssetToBuffer(assetId: number, maxBytes: number): Promise<Buffer> {
  const source = await openAssetStream(assetId, maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`Release asset exceeded the ${maxBytes} byte download limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function pickAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const preferred = assets.find(
    (a) => a.name.endsWith(".tar.gz") && a.name.includes(`linux-${arch}`)
  );
  const anyTar = assets.find((a) => a.name.endsWith(".tar.gz"));
  const picked = preferred ?? anyTar;
  if (!picked) {
    throw new Error("No .tar.gz release asset found");
  }
  return picked;
}

function requireAsset(
  assets: GithubReleaseAsset[],
  name: string
): GithubReleaseAsset {
  const found = assets.find((a) => a.name === name);
  if (!found) {
    throw new Error(
      `Release is missing the "${name}" asset, so its integrity cannot be verified. Releases must be signed; see docs on the release signing key.`
    );
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Signature and checksum verification
 * ------------------------------------------------------------------ */

/** Parses standard `sha256sum` output into a filename -> digest map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(\S.*)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS contains an unparseable line: ${safeLabel(line, 60)}`);
    }
    const digest = match[1].toLowerCase();
    const name = match[2].trim();
    const existing = entries.get(name);
    if (existing && existing !== digest) {
      throw new Error(`SHA256SUMS lists conflicting digests for ${safeLabel(name, 60)}`);
    }
    entries.set(name, digest);
  }
  if (entries.size === 0) {
    throw new Error("SHA256SUMS is empty");
  }
  return entries;
}

/**
 * Verifies the raw 64-byte ed25519 signature over the exact bytes of SHA256SUMS.
 *
 * Throws on every failure path — there is deliberately no way to skip this, warn
 * and continue, or fall back to an unverified install.
 */
export function verifyReleaseSignature(
  sumsBytes: Buffer,
  signatureBytes: Buffer,
  publicKeyPem: string
): void {
  assertReleaseKeyConfigured(publicKeyPem);

  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new Error(
      `${SIGNATURE_ASSET_NAME} must be a raw ${ED25519_SIGNATURE_BYTES}-byte ed25519 signature (received ${signatureBytes.length} bytes)`
    );
  }

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("The release signing public key is not a valid PEM SPKI key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `The release signing public key must be ed25519 (found "${key.asymmetricKeyType ?? "unknown"}")`
    );
  }

  // ed25519 takes the message directly: the algorithm argument must be null,
  // passing a digest name such as "sha256" throws.
  const valid = cryptoVerify(null, sumsBytes, key, signatureBytes);
  if (!valid) {
    throw new Error(
      `Release signature verification failed: ${SUMS_ASSET_NAME} is not signed by the DeckOS release key`
    );
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ *
 * Archive inspection
 * ------------------------------------------------------------------ */

type ArchiveSummary = {
  root: string;
  memberCount: number;
  uncompressedBytes: number;
};

/** Pull reader over an async byte stream, with a hard ceiling on bytes consumed. */
class ByteStreamReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
  private consumed = 0;

  constructor(
    source: AsyncIterable<Buffer | Uint8Array>,
    private readonly maxBytes: number
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  get bytesRead(): number {
    return this.consumed;
  }

  private async pull(): Promise<Buffer | null> {
    const next = await this.iterator.next();
    if (next.done) return null;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.consumed += chunk.length;
    if (this.consumed > this.maxBytes) {
      throw new Error(
        `Release archive expands to more than the ${this.maxBytes} byte limit`
      );
    }
    return chunk;
  }

  /** Reads exactly `length` bytes, or returns null at end of stream. */
  async read(length: number): Promise<Buffer | null> {
    while (this.buffer.length < length) {
      const chunk = await this.pull();
      if (!chunk) break;
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
    if (this.buffer.length < length) return null;
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** Discards `length` bytes without buffering them. */
  async skip(length: number): Promise<boolean> {
    let remaining = length;
    if (this.buffer.length > 0) {
      const take = Math.min(this.buffer.length, remaining);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
    }
    while (remaining > 0) {
      const chunk = await this.pull();
      if (!chunk) return false;
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
      } else {
        this.buffer = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    return true;
  }

  async close(): Promise<void> {
    await this.iterator.return?.(undefined);
  }
}

function readTarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readTarOctal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  if (field.length > 0 && (field[0] & 0x80) !== 0) {
    throw new Error(
      "Release archive uses base-256 tar numeric fields, which exceed the supported size limits"
    );
  }
  const text = field.toString("latin1").replace(/\0/g, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error("Release archive has a malformed tar header");
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Release archive has a malformed tar header");
  }
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function hasValidTarChecksum(header: Buffer): boolean {
  let stored: number;
  try {
    stored = readTarOctal(header, 148, 8);
  } catch {
    return false;
  }
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  const text = payload.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) {
      records.set(record.slice(0, eq), record.slice(eq + 1));
    }
    offset += length;
  }
  return records;
}

/** Splits an archive path, rejecting anything that could escape the extract dir. */
function splitArchivePath(raw: string, what: string): string[] {
  if (raw.length === 0) {
    throw new Error(`Release archive contains an empty ${what}`);
  }
  if (raw.includes("\0") || raw.includes("\\")) {
    throw new Error(
      `Release archive ${what} contains an illegal character: ${safeLabel(raw)}`
    );
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Release archive ${what} is an absolute path: ${safeLabel(raw)}`);
  }
  const parts = raw.split("/");
  if (parts[parts.length - 1] === "") parts.pop();
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new Error(
        `Release archive ${what} escapes the archive root: ${safeLabel(raw)}`
      );
    }
  }
  if (parts.length === 0) {
    throw new Error(`Release archive contains an empty ${what}`);
  }
  return parts;
}

/**
 * Resolves a link target against the directory holding the link, relative to the
 * extraction root. Returns null when it would climb out of the root.
 */
function resolveLinkWithinRoot(baseSegments: string[], target: string): string[] | null {
  const out = [...baseSegments];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out;
}

/**
 * Walks a gzipped tar stream and validates every member before extraction.
 *
 * The signature check is the primary defence; this is the second layer, and it is
 * what turns "whatever GNU tar happens to do by default" into an explicit policy:
 * one known top-level directory, no traversal, no absolute paths, no device or
 * fifo members, link targets confined to the archive, and hard ceilings on member
 * size, member count and total expanded size.
 */
export async function inspectTarStream(
  source: AsyncIterable<Buffer | Uint8Array>
): Promise<ArchiveSummary> {
  const reader = new ByteStreamReader(source, MAX_UNCOMPRESSED_BYTES);
  let root: string | null = null;
  let memberCount = 0;
  let zeroBlocks = 0;
  let sawServerEntry = false;
  let longName: string | null = null;
  let longLink: string | null = null;
  let paxPath: string | null = null;
  let paxLink: string | null = null;

  try {
    for (;;) {
      const header = await reader.read(TAR_BLOCK);
      if (!header) break;
      if (isZeroBlock(header)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;

      if (!hasValidTarChecksum(header)) {
        throw new Error("Release archive is not a valid tar stream (bad header checksum)");
      }

      const size = readTarOctal(header, 124, 12);
      const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      const rawType = header[156];
      const typeFlag = String.fromCharCode(rawType === 0 ? 0x30 : rawType);

      if (typeFlag === "L" || typeFlag === "K") {
        if (size > MAX_ARCHIVE_METADATA_BYTES) {
          throw new Error("Release archive has an oversized long-name header");
        }
        const payload = await reader.read(padded);
        if (!payload) throw new Error("Release archive is truncated");
        const value = payload.subarray(0, size).toString("utf8").replace(/\0+$/, "");
        if (typeFlag === "L") longName = value;
        else longLink = value;
        continue;
      }

      if (typeFlag === "x" || typeFlag === "X" || typeFlag === "g") {
        if (size > MAX_ARCHIVE_METADATA_BYTES) {
          throw new Error("Release archive has an oversized extended header");
        }
        const payload = await reader.read(padded);
        if (!payload) throw new Error("Release archive is truncated");
        if (typeFlag !== "g") {
          const records = parsePaxRecords(payload.subarray(0, size));
          paxPath = records.get("path") ?? null;
          paxLink = records.get("linkpath") ?? null;
        }
        continue;
      }

      const rawName = readTarString(header, 0, 100);
      const prefix = readTarString(header, 345, 155);
      const name = paxPath ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      const linkTarget = paxLink ?? longLink ?? readTarString(header, 157, 100);
      longName = null;
      longLink = null;
      paxPath = null;
      paxLink = null;

      memberCount += 1;
      if (memberCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `Release archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`
        );
      }
      if (size > MAX_MEMBER_BYTES) {
        throw new Error(
          `Release archive member ${safeLabel(name)} is larger than the ${MAX_MEMBER_BYTES} byte limit`
        );
      }

      // Regular ("0"/"7"), directory ("5"), hard link ("1") and symlink ("2") only.
      // Character/block devices, fifos and volume headers have no business in a
      // release tarball and are refused outright.
      if (!["0", "1", "2", "5", "7"].includes(typeFlag)) {
        throw new Error(
          `Release archive member ${safeLabel(name)} has an unsupported tar entry type "${safeLabel(typeFlag, 4)}"`
        );
      }

      const segments = splitArchivePath(name, "member name");
      const memberRoot = segments[0];
      if (root === null) {
        if (!ARCHIVE_ROOT_RE.test(memberRoot)) {
          throw new Error(
            `Release archive has an unexpected top-level directory: ${safeLabel(memberRoot)}`
          );
        }
        root = memberRoot;
      } else if (memberRoot !== root) {
        throw new Error(
          `Release archive contains more than one top-level directory (${safeLabel(root)}, ${safeLabel(memberRoot)})`
        );
      }

      // Everything below is expressed relative to the extraction directory, i.e.
      // after `--strip-components=1` has removed the wrapper directory.
      const rest = segments.slice(1);
      if (rest.length > 0 && !ALLOWED_TOP_LEVEL_ENTRIES.has(rest[0])) {
        throw new Error(
          `Release archive contains an unexpected top-level entry: ${safeLabel(rest[0])}`
        );
      }
      if (rest.join("/") === SERVER_ENTRY_PATH) {
        sawServerEntry = true;
      }

      if (typeFlag === "1" || typeFlag === "2") {
        if (linkTarget.length === 0) {
          throw new Error(`Release archive member ${safeLabel(name)} has an empty link target`);
        }
        if (linkTarget.startsWith("/")) {
          throw new Error(
            `Release archive member ${safeLabel(name)} links to an absolute path: ${safeLabel(linkTarget)}`
          );
        }
        if (typeFlag === "1") {
          // A hard link target is a path relative to the archive itself, so it
          // must sit under the same top-level directory as everything else.
          const targetSegments = splitArchivePath(linkTarget, "hard link target");
          if (targetSegments[0] !== root) {
            throw new Error(
              `Release archive member ${safeLabel(name)} hard links outside the archive: ${safeLabel(linkTarget)}`
            );
          }
        } else {
          // A symlink target is relative to the directory holding the link, and
          // must not climb out of the extraction directory.
          const resolved = resolveLinkWithinRoot(rest.slice(0, -1), linkTarget);
          if (!resolved) {
            throw new Error(
              `Release archive member ${safeLabel(name)} symlinks outside the extraction directory: ${safeLabel(linkTarget)}`
            );
          }
        }
      }

      if (padded > 0 && !(await reader.skip(padded))) {
        throw new Error("Release archive is truncated");
      }
    }
  } finally {
    await reader.close();
  }

  if (!root) {
    throw new Error("Release archive is empty");
  }
  if (!sawServerEntry) {
    throw new Error(`Release archive is missing ${SERVER_ENTRY_PATH}`);
  }

  return { root, memberCount, uncompressedBytes: reader.bytesRead };
}

/**
 * Decompresses the downloaded tarball and validates it without writing anything.
 * Doubles as the `gzip -t` integrity check that install.sh performs and the
 * updater previously skipped.
 */
export async function inspectReleaseArchive(tarPath: string): Promise<ArchiveSummary> {
  const fileStream = createReadStream(tarPath);
  const gunzip = createGunzip();
  fileStream.on("error", (err) => gunzip.destroy(err));
  fileStream.pipe(gunzip);
  try {
    return await inspectTarStream(gunzip);
  } finally {
    fileStream.destroy();
    gunzip.destroy();
  }
}

async function resolveTarBinary(override?: string): Promise<string> {
  const candidates = override ? [override] : TAR_BINARY_CANDIDATES;
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && (await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate the tar binary at an absolute path (looked at ${candidates.join(", ")})`
  );
}

/* ------------------------------------------------------------------ *
 * Release directory management
 * ------------------------------------------------------------------ */

async function getCurrentReleaseVersion(
  currentLink: string,
  releasesDir: string
): Promise<string | null> {
  try {
    const linkedPath = await readlink(currentLink);
    const resolvedPath = isAbsolute(linkedPath)
      ? linkedPath
      : resolve(dirname(currentLink), linkedPath);
    if (!isWithinPath(releasesDir, resolvedPath)) {
      return null;
    }
    const name = basename(resolvedPath).trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The release directory this process is executing from, independent of the
 * `current` symlink (Node resolves module paths through symlinks, so this stays
 * correct even when `current` is broken or points somewhere else).
 */
function getRunningReleaseVersion(releasesDir: string): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    const rel = relative(resolve(releasesDir), resolve(here));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    const [first] = rel.split(/[\\/]/);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Repoints `current` at `targetDir`.
 *
 * The symlink is built under a temporary name and renamed into place, so on POSIX
 * the swap is atomic and a failure part way through cannot leave the install
 * without a `current` at all. The fallback covers filesystems that refuse to
 * rename over an existing symlink.
 */
async function pointCurrentAt(currentLink: string, targetDir: string): Promise<void> {
  const tmpLink = `${currentLink}.new-${process.pid}-${Date.now()}`;
  await rm(tmpLink, { recursive: true, force: true });
  await symlink(targetDir, tmpLink, "dir");
  try {
    await rename(tmpLink, currentLink);
  } catch {
    await rm(currentLink, { recursive: true, force: true });
    await rename(tmpLink, currentLink);
  }
}

/**
 * Deletes old releases, keeping `KEEP_RELEASES` of them plus everything in
 * `protectedVersions`.
 *
 * Previously this deleted every directory that was not the new one, which meant a
 * `current` symlink that could not be read took the only rollback target — and the
 * directory the process was executing from — with it.
 */
async function pruneReleases(
  releasesDir: string,
  protectedVersions: ReadonlySet<string>,
  keep: number = KEEP_RELEASES
): Promise<void> {
  let entries;
  try {
    entries = await readdir(releasesDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  const candidates: { name: string; mtimeMs: number }[] = [];
  const staleTmpDirs: string[] = [];
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (protectedVersions.has(name)) continue;

    let mtimeMs: number;
    try {
      const stats = await stat(join(releasesDir, name));
      mtimeMs = stats.mtimeMs;
    } catch {
      continue;
    }

    if (name.endsWith(".tmp")) {
      // Only reap abandoned extraction dirs, never one an install is using.
      if (now - mtimeMs > STALE_TMP_DIR_AGE_MS) staleTmpDirs.push(name);
      continue;
    }
    // Anything that is not a recognisable release directory is left alone.
    if (!isValidReleaseVersion(name)) continue;
    candidates.push({ name, mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepCount = Math.max(0, keep - protectedVersions.size);
  const removable = [...candidates.slice(keepCount).map((c) => c.name), ...staleTmpDirs];

  for (const name of removable) {
    await removeTree(join(releasesDir, name));
  }
}

function scheduleRestart(): void {
  setTimeout(() => {
    process.exit(0);
  }, 250);
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export async function applyUpdate(
  version?: string,
  overrides?: SelfUpdateOverrides
): Promise<ApplyUpdateResult> {
  if (updateInProgress && Date.now() - updateStartedAt < UPDATE_LOCK_MAX_AGE_MS) {
    throw new Error("Update already in progress");
  }
  if (process.platform !== "linux") {
    throw new Error("Self-update is only supported on Linux");
  }

  acquireUpdateLock();
  let updateWorkDir = "";
  let extractTmp = "";
  try {
    const status = await getUpdateStatus();
    if (!status.enabled) throw new Error(status.error || "Updates are disabled");

    const installRoot = getInstallRoot();
    const releasesDir = join(installRoot, "releases");
    const currentLink = join(installRoot, "current");
    const previousVersion = await getCurrentReleaseVersion(currentLink, releasesDir);
    const runningVersion = getRunningReleaseVersion(releasesDir);

    let tag: string | null = null;
    if (version) {
      const requested = normalizeVersion(version);
      if (!isValidReleaseVersion(requested)) {
        throw new Error(
          `Refusing to act on release version "${safeLabel(version)}": not a valid semver version`
        );
      }
      tag = `v${requested}`;
    }

    const release = tag ? await fetchReleaseByTag(tag) : await fetchLatestRelease();
    if (release.draft) throw new Error("Cannot install a draft release");
    if (release.prerelease) throw new Error("Cannot install a prerelease");

    const targetVersion = normalizeVersion(release.tag_name ?? "");
    if (!targetVersion) throw new Error("Invalid release tag");
    // Validates the tag before it is ever used to build a filesystem path.
    const targetDir = resolveReleaseDir(releasesDir, targetVersion);

    if (!version && !status.updateAvailable) {
      throw new Error("No update available");
    }

    const assets = release.assets || [];
    const asset = pickAsset(assets);

    const targetMarker = join(targetDir, "packages", "server", "dist", "index.js");
    if (await pathExists(targetMarker)) {
      // The directory being present is not the same as it being live: after a
      // manual rollback the old tree is still on disk while `current` points
      // elsewhere. Only skip the work when `current` really resolves to it.
      if (previousVersion === targetVersion) {
        return { targetVersion, restarting: false };
      }
      await pointCurrentAt(currentLink, targetDir);
      clearUpdateStatusCache();
      scheduleRestart();
      return { targetVersion, restarting: true };
    }

    if (runningVersion && runningVersion === targetVersion) {
      throw new Error(
        `Refusing to overwrite ${targetVersion}: the server is running from that release directory`
      );
    }

    const publicKeyPem = overrides?.publicKeyPem ?? RELEASE_PUBLIC_KEY_PEM;
    // Fail before downloading anything if verification could never succeed.
    assertReleaseKeyConfigured(publicKeyPem);
    const sumsAsset = requireAsset(assets, SUMS_ASSET_NAME);
    const signatureAsset = requireAsset(assets, SIGNATURE_ASSET_NAME);
    const tarBinary = await resolveTarBinary(overrides?.tarBinary);

    await mkdir(releasesDir, { recursive: true });
    const updateTmpRoot = getUpdateTmpRoot();
    await mkdir(updateTmpRoot, { recursive: true });

    updateWorkDir = join(
      updateTmpRoot,
      `deckos-update-${targetVersion}-${process.pid}-${Date.now()}`
    );
    await removeTree(updateWorkDir);
    await mkdir(updateWorkDir, { recursive: true });

    // 1. Manifest and detached signature.
    const sumsBytes = await downloadAssetToBuffer(sumsAsset.id, MAX_SUMS_BYTES);
    const signatureBytes = await downloadAssetToBuffer(
      signatureAsset.id,
      MAX_SIGNATURE_BYTES
    );

    // 2. The signature must be valid before the manifest is trusted for anything.
    verifyReleaseSignature(sumsBytes, signatureBytes, publicKeyPem);
    const sums = parseSha256Sums(sumsBytes.toString("utf8"));

    // 3. Only now fetch the tarball, and only accept it if the signed manifest
    //    vouches for exactly these bytes.
    // The on-disk name is derived locally: `asset.name` is API-controlled and is
    // only ever used as a lookup key into the signed manifest.
    const tarPath = join(updateWorkDir, `deckos-${targetVersion}.tar.gz`);
    await downloadAssetToFile(asset.id, tarPath, MAX_TARBALL_BYTES);

    const expectedDigest = sums.get(asset.name);
    if (!expectedDigest) {
      throw new Error(
        `${SUMS_ASSET_NAME} does not list ${safeLabel(asset.name)}, so the download cannot be verified`
      );
    }
    const actualDigest = await sha256File(tarPath);
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `Release checksum mismatch for ${safeLabel(asset.name)}: signed manifest expects ${expectedDigest}, downloaded file is ${actualDigest}`
      );
    }

    // 4. Validate every archive member before handing the file to tar.
    await inspectReleaseArchive(tarPath);

    extractTmp = join(releasesDir, `${targetVersion}.tmp`);
    await removeTree(extractTmp);
    await mkdir(extractTmp, { recursive: true });

    await execFile(
      tarBinary,
      [
        "-xzf",
        tarPath,
        "-C",
        extractTmp,
        "--strip-components=1",
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: EXTRACT_MAX_OUTPUT_BYTES }
    );

    // The archive chooses its own directory modes, so normalise before anything
    // tries to traverse, replace or clean up the extracted tree.
    await ensureTreeTraversable(extractTmp);

    const extractedMarker = join(extractTmp, "packages", "server", "dist", "index.js");
    if (!(await pathExists(extractedMarker))) {
      throw new Error("Release archive missing expected server build output");
    }

    await removeTree(targetDir);
    await rename(extractTmp, targetDir);
    extractTmp = "";

    try {
      await pointCurrentAt(currentLink, targetDir);
    } catch (err) {
      // The new tree is staged but not live; put `current` back so the box stays
      // bootable, then surface the failure.
      if (previousVersion) {
        const previousDir = join(releasesDir, previousVersion);
        try {
          await pointCurrentAt(currentLink, previousDir);
        } catch {
          // Nothing further we can do in-band.
        }
      }
      throw new Error(
        `Failed to activate release ${targetVersion}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    const activeVersion = await getCurrentReleaseVersion(currentLink, releasesDir);
    if (!activeVersion) {
      // If `current` cannot be read we cannot tell what is live, so nothing is
      // deleted. Better to keep stale releases than to delete the rollback target.
      console.warn(
        "[deckos] Skipping release prune: the current symlink could not be resolved"
      );
    } else {
      const keepVersions = new Set<string>([targetVersion, activeVersion]);
      if (previousVersion) keepVersions.add(previousVersion);
      if (runningVersion) keepVersions.add(runningVersion);
      try {
        await pruneReleases(releasesDir, keepVersions);
      } catch (err) {
        // Never fail an otherwise-good update because cleanup failed.
        console.warn("[deckos] Failed to prune old releases:", err);
      }
    }

    clearUpdateStatusCache();
    scheduleRestart();

    return { targetVersion, restarting: true };
  } finally {
    releaseUpdateLock();
    if (extractTmp) {
      await removeTree(extractTmp);
    }
    if (updateWorkDir) {
      await removeTree(updateWorkDir);
    }
  }
}

/**
 * Repoints `current` at a previously installed release and restarts.
 *
 * With `Restart=always`, a release that does not boot is a crash loop with no UI,
 * so a rollback path that does not depend on the new build running is required.
 * Without `version` the most recently installed other release is chosen.
 */
export async function rollbackToPreviousRelease(
  version?: string
): Promise<ApplyUpdateResult> {
  if (updateInProgress && Date.now() - updateStartedAt < UPDATE_LOCK_MAX_AGE_MS) {
    throw new Error("Update already in progress");
  }
  if (process.platform !== "linux") {
    throw new Error("Self-update is only supported on Linux");
  }

  acquireUpdateLock();
  try {
    const installRoot = getInstallRoot();
    const releasesDir = join(installRoot, "releases");
    const currentLink = join(installRoot, "current");
    const activeVersion = await getCurrentReleaseVersion(currentLink, releasesDir);

    const hasServerBuild = async (name: string): Promise<boolean> =>
      await pathExists(join(releasesDir, name, "packages", "server", "dist", "index.js"));

    if (version) {
      const requested = normalizeVersion(version);
      const targetDir = resolveReleaseDir(releasesDir, requested);
      if (!(await hasServerBuild(requested))) {
        throw new Error(`Release ${safeLabel(requested)} is not installed`);
      }
      if (activeVersion === requested) {
        return { targetVersion: requested, restarting: false };
      }
      await pointCurrentAt(currentLink, targetDir);
      clearUpdateStatusCache();
      scheduleRestart();
      return { targetVersion: requested, restarting: true };
    }

    let entries;
    try {
      entries = await readdir(releasesDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      throw new Error("No installed releases were found to roll back to");
    }

    const candidates: { name: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === activeVersion) continue;
      if (!isValidReleaseVersion(entry.name)) continue;
      if (!(await hasServerBuild(entry.name))) continue;
      try {
        candidates.push({
          name: entry.name,
          mtimeMs: (await stat(join(releasesDir, entry.name))).mtimeMs,
        });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const previous = candidates[0];
    if (!previous) {
      throw new Error("No other installed release is available to roll back to");
    }

    await pointCurrentAt(currentLink, resolveReleaseDir(releasesDir, previous.name));
    clearUpdateStatusCache();
    scheduleRestart();
    return { targetVersion: previous.name, restarting: true };
  } finally {
    releaseUpdateLock();
  }
}
