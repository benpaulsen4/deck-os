import { randomBytes, pbkdf2, timingSafeEqual, createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
 * Global ceiling across every source address. The per-IP limiter alone does not
 * slow an attacker who can spread guesses over many hosts on the LAN.
 */
const GLOBAL_FAILED_ATTEMPT_LIMIT = 20;
const FAILED_COOLDOWN_BASE_MS = 5 * 60 * 1000;
const FAILED_COOLDOWN_MAX_MS = 30 * 60 * 1000;

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
const globalFailedAttempts: FailedAttemptRecord = {
  failedAtMs: [],
  cooldownUntilMs: 0,
  cooldownLevel: 0,
};

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
    await writeFile(tempPath, serialized, { encoding: "utf8", mode: AUTH_FILE_MODE });
    await rename(tempPath, authConfigPath);
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

function getOrCreateAttemptRecord(ip: string): FailedAttemptRecord {
  const existing = failedAttemptsByIp.get(ip);
  if (existing) {
    return existing;
  }
  const initial: FailedAttemptRecord = {
    failedAtMs: [],
    cooldownUntilMs: 0,
    cooldownLevel: 0,
  };
  failedAttemptsByIp.set(ip, initial);
  return initial;
}

function pruneAttemptWindow(record: FailedAttemptRecord, atMs: number) {
  record.failedAtMs = record.failedAtMs.filter(
    (value) => atMs - value <= FAILED_ATTEMPT_WINDOW_MS
  );
}

function isRecordIdle(record: FailedAttemptRecord, atMs: number) {
  return record.cooldownUntilMs <= atMs && record.failedAtMs.length === 0;
}

/**
 * Drops per-IP records whose attempt window and cooldown have both lapsed, so
 * the map cannot grow without bound, and decays the global cooldown level once
 * the system has been quiet for a full window.
 */
function pruneFailedAttempts(atMs: number) {
  for (const [ip, record] of failedAttemptsByIp.entries()) {
    pruneAttemptWindow(record, atMs);
    if (isRecordIdle(record, atMs)) {
      failedAttemptsByIp.delete(ip);
    }
  }
  pruneAttemptWindow(globalFailedAttempts, atMs);
  if (isRecordIdle(globalFailedAttempts, atMs)) {
    globalFailedAttempts.cooldownLevel = 0;
  }
}

function applyFailure(record: FailedAttemptRecord, atMs: number, limit: number) {
  pruneAttemptWindow(record, atMs);
  record.failedAtMs.push(atMs);
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

function retryAfterMsFor(ip: string, atMs: number) {
  const record = failedAttemptsByIp.get(ip);
  return Math.max(
    0,
    record ? record.cooldownUntilMs - atMs : 0,
    globalFailedAttempts.cooldownUntilMs - atMs
  );
}

function assertNotRateLimited(ip: string, atMs: number) {
  pruneFailedAttempts(atMs);
  const retryAfterMs = retryAfterMsFor(ip, atMs);
  if (retryAfterMs > 0) {
    throw new AuthRateLimitedError(retryAfterMs);
  }
}

function recordFailedAttempt(ip: string, atMs: number) {
  applyFailure(getOrCreateAttemptRecord(ip), atMs, FAILED_ATTEMPT_LIMIT);
  applyFailure(globalFailedAttempts, atMs, GLOBAL_FAILED_ATTEMPT_LIMIT);
}

function resetAttempts(ip: string) {
  failedAttemptsByIp.delete(ip);
  // A successful unlock clears the accumulated global window (an active global
  // cooldown is intentionally left in place; it cannot be reached anyway).
  globalFailedAttempts.failedAtMs = [];
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
  if (!(await verifyPasscode(config, passcode))) {
    recordFailedAttempt(input.ip, atMs);
    throw new AuthInvalidPasscodeError();
  }
  resetAttempts(input.ip);
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
  globalFailedAttempts.failedAtMs = [];
  globalFailedAttempts.cooldownUntilMs = 0;
  globalFailedAttempts.cooldownLevel = 0;
}

export function getTrackedFailedAttemptIpsForTests(): string[] {
  return [...failedAttemptsByIp.keys()];
}

export function setAuthStoragePathForTests(baseDir: string) {
  authDirPath = join(baseDir, "security");
  authConfigPath = join(authDirPath, "passcode.json");
  resetAuthStateForTests();
}
