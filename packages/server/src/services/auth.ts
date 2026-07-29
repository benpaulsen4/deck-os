import { randomBytes, pbkdf2, timingSafeEqual, createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "../lib/config.js";
import {
  AUTH_DEFAULT_SESSION_DURATION_MS,
  PasscodeSchema,
  SessionDurationMsSchema,
} from "../lib/schema.js";

const pbkdf2Async = promisify(pbkdf2);

let authDirPath = join(DATA_DIR, "security");
let authConfigPath = join(authDirPath, "passcode.json");

const PASSCODE_HASH_ITERATIONS = 310_000;
const PASSCODE_HASH_DIGEST = "sha256";
const PASSCODE_KEY_LENGTH = 32;

/** The passcode salt+hash must never be readable by other local accounts. */
const AUTH_DIR_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;

const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const FAILED_ATTEMPT_LIMIT = 5;
/**
 * Ceiling for a whole client network (IPv4 /24, IPv6 /64). The per-IP limiter
 * alone does not slow an attacker who spreads guesses over many addresses --
 * trivial over IPv6, where a single host owns an entire /64.
 *
 * Deliberately scoped to a network rather than made truly global: a global
 * counter lets any one device on any subnet put every other user into cooldown.
 */
const NETWORK_FAILED_ATTEMPT_LIMIT = 20;
const FAILED_COOLDOWN_BASE_MS = 5 * 60 * 1000;
const FAILED_COOLDOWN_MAX_MS = 30 * 60 * 1000;
/**
 * How long a record survives with no new attempts. Records must NOT be dropped
 * as soon as their cooldown lapses: `cooldownLevel` lives on the record, so
 * evicting it there would reset the escalation and flatten repeated bursts into
 * a constant 5-per-5-minutes.
 */
const ATTEMPT_RECORD_TTL_MS = FAILED_ATTEMPT_WINDOW_MS + FAILED_COOLDOWN_MAX_MS;

type PersistedAuthConfig = {
  enabled: boolean;
  sessionDurationMs: number;
  passcodeHash: string | null;
  passcodeSalt: string | null;
  passcodeIterations: number;
  passcodeDigest: string;
};

type SessionRecord = {
  tokenHash: string;
  expiresAt: number;
};

type FailedAttemptRecord = {
  failedAtMs: number[];
  cooldownUntilMs: number;
  cooldownLevel: number;
  lastAttemptMs: number;
};

export class AuthRateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Too many failed attempts. Please try again later.");
    this.name = "AuthRateLimitedError";
  }
}

export class AuthInvalidPasscodeError extends Error {
  constructor() {
    super("Invalid passcode.");
    this.name = "AuthInvalidPasscodeError";
  }
}

export class AuthNotEnabledError extends Error {
  constructor() {
    super("Passcode authentication is not enabled.");
    this.name = "AuthNotEnabledError";
  }
}

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthValidationError";
  }
}

/**
 * Raised when the persisted passcode config exists but cannot be read or parsed.
 * Callers must treat this as "locked", never as "auth is off".
 */
export class AuthConfigUnavailableError extends Error {
  constructor() {
    super(
      "Passcode configuration could not be read. The panel stays locked until it is repaired."
    );
    this.name = "AuthConfigUnavailableError";
  }
}

let cachedConfig: PersistedAuthConfig | null = null;
const sessions = new Map<string, SessionRecord>();
const failedAttemptsByIp = new Map<string, FailedAttemptRecord>();
const failedAttemptsByNetwork = new Map<string, FailedAttemptRecord>();

function getDefaultConfig(): PersistedAuthConfig {
  return {
    enabled: false,
    sessionDurationMs: AUTH_DEFAULT_SESSION_DURATION_MS,
    passcodeHash: null,
    passcodeSalt: null,
    passcodeIterations: PASSCODE_HASH_ITERATIONS,
    passcodeDigest: PASSCODE_HASH_DIGEST,
  };
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function ensureConfigDir() {
  await mkdir(authDirPath, { recursive: true, mode: AUTH_DIR_MODE });
  // `mkdir` only applies the mode when it creates the directory, so tighten an
  // existing (pre-upgrade, 0755) directory explicitly.
  await chmod(authDirPath, AUTH_DIR_MODE).catch(() => undefined);
}

/**
 * Best-effort tightening of the on-disk permissions for installs created before
 * the modes above were enforced. Safe to call when nothing exists yet.
 */
export async function ensureAuthStoragePermissions() {
  for (const [target, mode] of [
    [authDirPath, AUTH_DIR_MODE],
    [authConfigPath, AUTH_FILE_MODE],
  ] as const) {
    try {
      await chmod(target, mode);
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        console.warn(`[deckos] Unable to tighten permissions on ${target}`, error);
      }
    }
  }
}

function sanitizeConfig(input: unknown): PersistedAuthConfig {
  if (!input || typeof input !== "object") {
    return getDefaultConfig();
  }
  const candidate = input as Partial<PersistedAuthConfig>;
  const enabled = candidate.enabled === true;
  const sessionDurationMs = SessionDurationMsSchema.safeParse(candidate.sessionDurationMs)
    .success
    ? (candidate.sessionDurationMs as number)
    : AUTH_DEFAULT_SESSION_DURATION_MS;
  const passcodeHash =
    typeof candidate.passcodeHash === "string" && candidate.passcodeHash.length > 0
      ? candidate.passcodeHash
      : null;
  const passcodeSalt =
    typeof candidate.passcodeSalt === "string" && candidate.passcodeSalt.length > 0
      ? candidate.passcodeSalt
      : null;
  const passcodeIterations =
    typeof candidate.passcodeIterations === "number" &&
    Number.isInteger(candidate.passcodeIterations) &&
    candidate.passcodeIterations > 0
      ? candidate.passcodeIterations
      : PASSCODE_HASH_ITERATIONS;
  const passcodeDigest =
    typeof candidate.passcodeDigest === "string" && candidate.passcodeDigest.length > 0
      ? candidate.passcodeDigest
      : PASSCODE_HASH_DIGEST;
  return {
    enabled,
    sessionDurationMs,
    passcodeHash,
    passcodeSalt,
    passcodeIterations,
    passcodeDigest,
  };
}

/**
 * Makes a completed rename durable. Opening a directory for fsync is a POSIX
 * idiom that Windows rejects outright, so failures here are ignored.
 */
async function syncDirectory(dirPath: string) {
  try {
    const handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not supported on this platform; the file fsync above still applies.
  }
}

function reportUnreadableConfig(reason: string, detail?: unknown) {
  console.error(
    `[deckos] ${reason} (${authConfigPath}). Failing closed: the panel will report as locked ` +
      "until the file is repaired or removed.",
    detail ?? ""
  );
}

async function readConfig(): Promise<PersistedAuthConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  let raw: string;
  try {
    raw = await readFile(authConfigPath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      // No file at all is the legitimate "never configured" state.
      cachedConfig = getDefaultConfig();
      return cachedConfig;
    }
    reportUnreadableConfig("Passcode config could not be read", error);
    // Deliberately not cached: a transient IO error must not disable the lock
    // for the lifetime of the process.
    throw new AuthConfigUnavailableError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    reportUnreadableConfig("Passcode config is not valid JSON", error);
    throw new AuthConfigUnavailableError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    reportUnreadableConfig("Passcode config is not a JSON object");
    throw new AuthConfigUnavailableError();
  }

  cachedConfig = sanitizeConfig(parsed);
  return cachedConfig;
}

async function writeConfig(config: PersistedAuthConfig): Promise<PersistedAuthConfig> {
  await ensureConfigDir();
  const serialized = JSON.stringify(config, null, 2);
  // Write to a sibling temp file and rename, so a crash mid-write can never
  // leave a truncated (and therefore unreadable) passcode config behind.
  const tempPath = `${authConfigPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(tempPath, "wx", AUTH_FILE_MODE);
    try {
      await handle.writeFile(serialized, "utf8");
      // Without the fsync, rename only orders the *metadata*: a power cut can
      // still surface a zero-length file, which is precisely the corruption this
      // whole change exists to avoid.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, authConfigPath);
    await syncDirectory(authDirPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  await chmod(authConfigPath, AUTH_FILE_MODE).catch(() => undefined);
  cachedConfig = config;
  return config;
}

async function hashPasscode(
  passcode: string,
  saltHex: string,
  iterations: number,
  digest: string
): Promise<string> {
  const derived = await pbkdf2Async(
    passcode,
    Buffer.from(saltHex, "hex"),
    iterations,
    PASSCODE_KEY_LENGTH,
    digest
  );
  return derived.toString("hex");
}

async function verifyPasscode(
  config: PersistedAuthConfig,
  passcode: string
): Promise<boolean> {
  if (!config.passcodeHash || !config.passcodeSalt) {
    return false;
  }
  const computed = await hashPasscode(
    passcode,
    config.passcodeSalt,
    config.passcodeIterations,
    config.passcodeDigest
  );
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(config.passcodeHash, "hex");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function nowMs() {
  return Date.now();
}

function pruneSessions() {
  const now = nowMs();
  for (const [tokenHash, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(tokenHash);
    }
  }
}

/**
 * Groups an address with its neighbours: IPv4 by /24, IPv6 by /64. A /64 is the
 * smallest block routinely handed to a single host, so this stops one machine
 * from buying extra guesses simply by cycling through its own addresses.
 */
function getNetworkKey(ip: string): string {
  const address = ip.split("%")[0] ?? ip;
  if (address.includes(":")) {
    const groups = expandIpv6Groups(address);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
  }
  const octets = address.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  // Not an address we recognise (including the "unknown" placeholder): fall back
  // to the value itself so it still gets its own bucket.
  return address;
}

function expandIpv6Groups(address: string): string[] | null {
  const doubleColon = address.indexOf("::");
  let groups: string[];
  if (doubleColon >= 0) {
    const left = address.slice(0, doubleColon).split(":").filter(Boolean);
    const right = address
      .slice(doubleColon + 2)
      .split(":")
      .filter(Boolean);
    const missing = 8 - left.length - right.length;
    if (missing < 0) {
      return null;
    }
    groups = [...left, ...new Array<string>(missing).fill("0"), ...right];
  } else {
    groups = address.split(":");
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) {
    return null;
  }
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""));
}

function getOrCreateAttemptRecord(
  records: Map<string, FailedAttemptRecord>,
  key: string,
  atMs: number
): FailedAttemptRecord {
  const existing = records.get(key);
  if (existing) {
    return existing;
  }
  const initial: FailedAttemptRecord = {
    failedAtMs: [],
    cooldownUntilMs: 0,
    cooldownLevel: 0,
    lastAttemptMs: atMs,
  };
  records.set(key, initial);
  return initial;
}

function pruneAttemptWindow(record: FailedAttemptRecord, atMs: number) {
  record.failedAtMs = record.failedAtMs.filter(
    (value) => atMs - value <= FAILED_ATTEMPT_WINDOW_MS
  );
}

/**
 * Evicts records that have seen no attempt for a full window plus the longest
 * cooldown, so the maps cannot grow without bound. Eviction is keyed on
 * inactivity, never on cooldown expiry, so `cooldownLevel` survives long enough
 * for a repeat offender to escalate (5 -> 10 -> 20 minutes).
 */
function pruneFailedAttempts(atMs: number) {
  for (const records of [failedAttemptsByIp, failedAttemptsByNetwork]) {
    for (const [key, record] of records.entries()) {
      pruneAttemptWindow(record, atMs);
      if (atMs - record.lastAttemptMs > ATTEMPT_RECORD_TTL_MS) {
        records.delete(key);
      }
    }
  }
}

function applyFailure(record: FailedAttemptRecord, atMs: number, limit: number) {
  pruneAttemptWindow(record, atMs);
  record.failedAtMs.push(atMs);
  record.lastAttemptMs = atMs;
  if (record.failedAtMs.length >= limit) {
    record.failedAtMs = [];
    record.cooldownLevel = Math.min(record.cooldownLevel + 1, 3);
    const cooldownMs = Math.min(
      FAILED_COOLDOWN_BASE_MS * Math.pow(2, Math.max(0, record.cooldownLevel - 1)),
      FAILED_COOLDOWN_MAX_MS
    );
    record.cooldownUntilMs = atMs + cooldownMs;
  }
}

function snapshotRecord(record: FailedAttemptRecord): FailedAttemptRecord {
  return { ...record, failedAtMs: [...record.failedAtMs] };
}

function restoreRecord(target: FailedAttemptRecord, source: FailedAttemptRecord) {
  target.failedAtMs = [...source.failedAtMs];
  target.cooldownUntilMs = source.cooldownUntilMs;
  target.cooldownLevel = source.cooldownLevel;
  target.lastAttemptMs = source.lastAttemptMs;
}

function retryAfterMsFor(ip: string, atMs: number) {
  const ipRecord = failedAttemptsByIp.get(ip);
  const networkRecord = failedAttemptsByNetwork.get(getNetworkKey(ip));
  return Math.max(
    0,
    ipRecord ? ipRecord.cooldownUntilMs - atMs : 0,
    networkRecord ? networkRecord.cooldownUntilMs - atMs : 0
  );
}

function assertNotRateLimited(ip: string, atMs: number) {
  pruneFailedAttempts(atMs);
  const retryAfterMs = retryAfterMsFor(ip, atMs);
  if (retryAfterMs > 0) {
    throw new AuthRateLimitedError(retryAfterMs);
  }
}

/**
 * Records a failure and returns the rollback to run if the guess turns out to be
 * correct. Attempts must be booked *before* the (now asynchronous) hash is
 * awaited, otherwise every concurrent request clears the check before any of
 * them books a failure and both limiters are bypassed wholesale.
 */
function recordFailedAttempt(ip: string, atMs: number): () => void {
  const ipRecord = getOrCreateAttemptRecord(failedAttemptsByIp, ip, atMs);
  const networkKey = getNetworkKey(ip);
  const networkRecord = getOrCreateAttemptRecord(
    failedAttemptsByNetwork,
    networkKey,
    atMs
  );
  const networkBefore = snapshotRecord(networkRecord);

  applyFailure(ipRecord, atMs, FAILED_ATTEMPT_LIMIT);
  applyFailure(networkRecord, atMs, NETWORK_FAILED_ATTEMPT_LIMIT);

  return () => {
    // A correct passcode forgives the address outright, and un-books its own
    // contribution to the shared counter so a successful unlock can never be the
    // attempt that trips a network cooldown.
    failedAttemptsByIp.delete(ip);
    restoreRecord(networkRecord, networkBefore);
    networkRecord.failedAtMs = [];
    networkRecord.lastAttemptMs = atMs;
  };
}

function parsePasscode(input: string) {
  const result = PasscodeSchema.safeParse(input);
  if (!result.success) {
    throw new AuthValidationError("Passcode must be 4-10 digits.");
  }
  return result.data;
}

function parseSessionDurationMs(input: number) {
  const result = SessionDurationMsSchema.safeParse(input);
  if (!result.success) {
    throw new AuthValidationError("Session duration must be between 1 hour and 7 days.");
  }
  return result.data;
}

async function requireCurrentPasscode(
  config: PersistedAuthConfig,
  currentPasscode: string
) {
  const passcode = parsePasscode(currentPasscode);
  if (!(await verifyPasscode(config, passcode))) {
    throw new AuthInvalidPasscodeError();
  }
}

function clearAllSessions() {
  sessions.clear();
}

export async function getAuthStatus(sessionToken?: string | null) {
  let config: PersistedAuthConfig;
  try {
    config = await readConfig();
  } catch (error) {
    if (!(error instanceof AuthConfigUnavailableError)) {
      throw error;
    }
    // Fail closed. An already-issued session is still honoured so an operator
    // who is signed in can repair the file from the panel itself.
    pruneSessions();
    return {
      enabled: true,
      unlocked: isSessionValid(sessionToken),
      sessionDurationMs: AUTH_DEFAULT_SESSION_DURATION_MS,
    };
  }
  pruneSessions();
  const unlocked =
    config.enabled && sessionToken ? isSessionValid(sessionToken) : !config.enabled;
  return {
    enabled: config.enabled,
    unlocked,
    sessionDurationMs: config.sessionDurationMs,
  };
}

export async function configureAuth(input: {
  passcode: string;
  sessionDurationMs: number;
}) {
  const passcode = parsePasscode(input.passcode);
  const sessionDurationMs = parseSessionDurationMs(input.sessionDurationMs);
  const current = await readConfig();
  if (current.enabled) {
    throw new AuthValidationError("Passcode authentication is already enabled.");
  }
  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeHash = await hashPasscode(
    passcode,
    passcodeSalt,
    PASSCODE_HASH_ITERATIONS,
    PASSCODE_HASH_DIGEST
  );
  const nextConfig: PersistedAuthConfig = {
    enabled: true,
    sessionDurationMs,
    passcodeHash,
    passcodeSalt,
    passcodeIterations: PASSCODE_HASH_ITERATIONS,
    passcodeDigest: PASSCODE_HASH_DIGEST,
  };
  await writeConfig(nextConfig);
  clearAllSessions();
  return { enabled: true, sessionDurationMs };
}

export async function updateSessionDuration(input: {
  sessionDurationMs: number;
  currentPasscode: string;
}) {
  const sessionDurationMs = parseSessionDurationMs(input.sessionDurationMs);
  const config = await readConfig();
  if (!config.enabled) {
    throw new AuthNotEnabledError();
  }
  await requireCurrentPasscode(config, input.currentPasscode);
  const nextConfig: PersistedAuthConfig = {
    ...config,
    sessionDurationMs,
  };
  await writeConfig(nextConfig);
  clearAllSessions();
  return { enabled: true, sessionDurationMs };
}

export async function changePasscode(input: {
  currentPasscode: string;
  nextPasscode: string;
  sessionDurationMs?: number;
}) {
  const config = await readConfig();
  if (!config.enabled) {
    throw new AuthNotEnabledError();
  }
  await requireCurrentPasscode(config, input.currentPasscode);
  const nextPasscode = parsePasscode(input.nextPasscode);
  const sessionDurationMs =
    input.sessionDurationMs === undefined
      ? config.sessionDurationMs
      : parseSessionDurationMs(input.sessionDurationMs);
  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeHash = await hashPasscode(
    nextPasscode,
    passcodeSalt,
    PASSCODE_HASH_ITERATIONS,
    PASSCODE_HASH_DIGEST
  );
  const nextConfig: PersistedAuthConfig = {
    enabled: true,
    sessionDurationMs,
    passcodeHash,
    passcodeSalt,
    passcodeIterations: PASSCODE_HASH_ITERATIONS,
    passcodeDigest: PASSCODE_HASH_DIGEST,
  };
  await writeConfig(nextConfig);
  clearAllSessions();
  return { enabled: true, sessionDurationMs };
}

export async function disableAuth(currentPasscode: string) {
  const config = await readConfig();
  if (!config.enabled) {
    return { enabled: false, sessionDurationMs: config.sessionDurationMs };
  }
  await requireCurrentPasscode(config, currentPasscode);
  const nextConfig = getDefaultConfig();
  await writeConfig(nextConfig);
  clearAllSessions();
  return { enabled: false, sessionDurationMs: nextConfig.sessionDurationMs };
}

export async function unlock(input: { passcode: string; ip: string }) {
  const config = await readConfig();
  if (!config.enabled) {
    throw new AuthNotEnabledError();
  }
  const passcode = parsePasscode(input.passcode);
  const atMs = nowMs();
  assertNotRateLimited(input.ip, atMs);
  // Book the attempt optimistically. `assertNotRateLimited` and this call are
  // one synchronous block, so concurrent requests are serialised through it;
  // booking after `await verifyPasscode` would let an unbounded number of
  // parallel requests each pass the check before any failure was recorded.
  const rollbackAttempt = recordFailedAttempt(input.ip, atMs);
  if (!(await verifyPasscode(config, passcode))) {
    throw new AuthInvalidPasscodeError();
  }
  rollbackAttempt();
  pruneSessions();
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const expiresAt = atMs + config.sessionDurationMs;
  sessions.set(tokenHash, { tokenHash, expiresAt });
  return { token, expiresAt, sessionDurationMs: config.sessionDurationMs };
}

export function isSessionValid(sessionToken?: string | null) {
  if (!sessionToken) {
    return false;
  }
  pruneSessions();
  const tokenHash = hashSessionToken(sessionToken);
  const session = sessions.get(tokenHash);
  if (!session) {
    return false;
  }
  if (session.expiresAt <= nowMs()) {
    sessions.delete(tokenHash);
    return false;
  }
  return true;
}

export function revokeSession(sessionToken?: string | null) {
  if (!sessionToken) {
    return;
  }
  sessions.delete(hashSessionToken(sessionToken));
}

export function getRateLimitRetryAfterMs(ip: string) {
  return retryAfterMsFor(ip, nowMs());
}

export function getAuthCookieName() {
  return "deckos_session";
}

export function resetAuthStateForTests() {
  cachedConfig = null;
  sessions.clear();
  failedAttemptsByIp.clear();
  failedAttemptsByNetwork.clear();
}

export function getFailedAttemptKeysForTests() {
  return {
    ips: [...failedAttemptsByIp.keys()],
    networks: [...failedAttemptsByNetwork.keys()],
  };
}

export function getCooldownMsForTests(ip: string) {
  const atMs = nowMs();
  return {
    ip: Math.max(0, (failedAttemptsByIp.get(ip)?.cooldownUntilMs ?? 0) - atMs),
    network: Math.max(
      0,
      (failedAttemptsByNetwork.get(getNetworkKey(ip))?.cooldownUntilMs ?? 0) - atMs
    ),
  };
}

export function setAuthStoragePathForTests(baseDir: string) {
  authDirPath = join(baseDir, "security");
  authConfigPath = join(authDirPath, "passcode.json");
  resetAuthStateForTests();
}
