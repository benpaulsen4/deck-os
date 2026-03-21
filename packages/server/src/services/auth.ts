import { randomBytes, pbkdf2Sync, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../lib/config.js";
import {
  AUTH_DEFAULT_SESSION_DURATION_MS,
  PasscodeSchema,
  SessionDurationMsSchema,
} from "../lib/schema.js";

let authDirPath = join(DATA_DIR, "security");
let authConfigPath = join(authDirPath, "passcode.json");

const PASSCODE_HASH_ITERATIONS = 310_000;
const PASSCODE_HASH_DIGEST = "sha256";
const PASSCODE_KEY_LENGTH = 32;

const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const FAILED_ATTEMPT_LIMIT = 5;
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

let cachedConfig: PersistedAuthConfig | null = null;
const sessions = new Map<string, SessionRecord>();
const failedAttemptsByIp = new Map<string, FailedAttemptRecord>();

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

async function ensureConfigDir() {
  await mkdir(authDirPath, { recursive: true });
}

function sanitizeConfig(input: unknown): PersistedAuthConfig {
  if (!input || typeof input !== "object") {
    return getDefaultConfig();
  }
  const candidate = input as Partial<PersistedAuthConfig>;
  const enabled = candidate.enabled === true;
  const sessionDurationMs = SessionDurationMsSchema.safeParse(candidate.sessionDurationMs).success
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

async function readConfig(): Promise<PersistedAuthConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  try {
    const raw = await readFile(authConfigPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    cachedConfig = sanitizeConfig(parsed);
    return cachedConfig;
  } catch {
    cachedConfig = getDefaultConfig();
    return cachedConfig;
  }
}

async function writeConfig(config: PersistedAuthConfig): Promise<PersistedAuthConfig> {
  await ensureConfigDir();
  await writeFile(authConfigPath, JSON.stringify(config, null, 2), "utf8");
  cachedConfig = config;
  return config;
}

function hashPasscode(passcode: string, saltHex: string, iterations: number, digest: string) {
  return pbkdf2Sync(passcode, Buffer.from(saltHex, "hex"), iterations, PASSCODE_KEY_LENGTH, digest)
    .toString("hex");
}

function verifyPasscode(config: PersistedAuthConfig, passcode: string): boolean {
  if (!config.passcodeHash || !config.passcodeSalt) {
    return false;
  }
  const computed = hashPasscode(
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
  const initial: FailedAttemptRecord = { failedAtMs: [], cooldownUntilMs: 0, cooldownLevel: 0 };
  failedAttemptsByIp.set(ip, initial);
  return initial;
}

function pruneAttemptWindow(record: FailedAttemptRecord, atMs: number) {
  record.failedAtMs = record.failedAtMs.filter((value) => atMs - value <= FAILED_ATTEMPT_WINDOW_MS);
}

function assertNotRateLimited(ip: string, atMs: number) {
  const record = getOrCreateAttemptRecord(ip);
  if (record.cooldownUntilMs > atMs) {
    throw new AuthRateLimitedError(record.cooldownUntilMs - atMs);
  }
}

function recordFailedAttempt(ip: string, atMs: number) {
  const record = getOrCreateAttemptRecord(ip);
  pruneAttemptWindow(record, atMs);
  record.failedAtMs.push(atMs);
  if (record.failedAtMs.length >= FAILED_ATTEMPT_LIMIT) {
    record.failedAtMs = [];
    record.cooldownLevel = Math.min(record.cooldownLevel + 1, 3);
    const cooldownMs = Math.min(
      FAILED_COOLDOWN_BASE_MS * Math.pow(2, Math.max(0, record.cooldownLevel - 1)),
      FAILED_COOLDOWN_MAX_MS
    );
    record.cooldownUntilMs = atMs + cooldownMs;
  }
}

function resetAttempts(ip: string) {
  failedAttemptsByIp.delete(ip);
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

function requireCurrentPasscode(config: PersistedAuthConfig, currentPasscode: string) {
  const passcode = parsePasscode(currentPasscode);
  if (!verifyPasscode(config, passcode)) {
    throw new AuthInvalidPasscodeError();
  }
}

function clearAllSessions() {
  sessions.clear();
}

export async function getAuthStatus(sessionToken?: string | null) {
  const config = await readConfig();
  pruneSessions();
  const unlocked = config.enabled && sessionToken ? isSessionValid(sessionToken) : !config.enabled;
  return {
    enabled: config.enabled,
    unlocked,
    sessionDurationMs: config.sessionDurationMs,
  };
}

export async function configureAuth(input: { passcode: string; sessionDurationMs: number }) {
  const passcode = parsePasscode(input.passcode);
  const sessionDurationMs = parseSessionDurationMs(input.sessionDurationMs);
  const current = await readConfig();
  if (current.enabled) {
    throw new AuthValidationError("Passcode authentication is already enabled.");
  }
  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeHash = hashPasscode(
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
  requireCurrentPasscode(config, input.currentPasscode);
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
  requireCurrentPasscode(config, input.currentPasscode);
  const nextPasscode = parsePasscode(input.nextPasscode);
  const sessionDurationMs =
    input.sessionDurationMs === undefined
      ? config.sessionDurationMs
      : parseSessionDurationMs(input.sessionDurationMs);
  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeHash = hashPasscode(
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
  requireCurrentPasscode(config, currentPasscode);
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
  if (!verifyPasscode(config, passcode)) {
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
  const record = failedAttemptsByIp.get(ip);
  if (!record) {
    return 0;
  }
  return Math.max(0, record.cooldownUntilMs - nowMs());
}

export function getAuthCookieName() {
  return "deckos_session";
}

export function resetAuthStateForTests() {
  cachedConfig = null;
  sessions.clear();
  failedAttemptsByIp.clear();
}

export function setAuthStoragePathForTests(baseDir: string) {
  authDirPath = join(baseDir, "security");
  authConfigPath = join(authDirPath, "passcode.json");
  resetAuthStateForTests();
}
