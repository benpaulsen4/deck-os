export type AuthStatus = {
  enabled: boolean;
  unlocked: boolean;
  sessionDurationMs: number;
};

/**
 * How an auth request failed. The two interesting cases come from the hardened
 * server routes:
 *
 * - `config-unavailable` (503): the persisted passcode config exists but cannot
 *   be read or parsed. The server fails closed, so this is *not* a wrong
 *   passcode and no amount of retyping will help -- the file has to be repaired.
 * - `malformed-request` (415): the route refused the body because the
 *   content-type was not `application/json`. The SPA always sends it, so this
 *   means something between the browser and the server rewrote the request.
 */
export type AuthFailureKind =
  | "config-unavailable"
  | "malformed-request"
  | "unauthorized"
  | "rate-limited"
  | "invalid-request"
  | "server-error"
  | "network";

export const AUTH_CONFIG_UNAVAILABLE_MESSAGE =
  "Passcode configuration is unreadable, so DeckOS stays locked. This is not a wrong " +
  "passcode: repair or remove the passcode file in the DeckOS data directory " +
  "(security/passcode.json) on the host, then reload.";

export const AUTH_MALFORMED_REQUEST_MESSAGE =
  "The server rejected this request as malformed (it expects a JSON body). Reload the " +
  "page, and if DeckOS sits behind a reverse proxy check that it forwards the " +
  "Content-Type header.";

export const AUTH_STATUS_UNAVAILABLE_MESSAGE =
  "Could not read the security status from the server, so DeckOS is staying locked. " +
  "Retrying...";

export class AuthRequestError extends Error {
  readonly kind: AuthFailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    kind: AuthFailureKind,
    message: string,
    options?: { status?: number | null; retryAfterMs?: number | null; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AuthRequestError";
    this.kind = kind;
    this.status = options?.status ?? null;
    this.retryAfterMs = options?.retryAfterMs ?? null;
  }
}

export function classifyAuthStatusCode(status: number): AuthFailureKind {
  if (status === 503) return "config-unavailable";
  if (status === 415) return "malformed-request";
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status >= 400 && status < 500) return "invalid-request";
  return "server-error";
}

function defaultMessageForKind(kind: AuthFailureKind, status: number | null): string {
  switch (kind) {
    case "config-unavailable":
      return AUTH_CONFIG_UNAVAILABLE_MESSAGE;
    case "malformed-request":
      return AUTH_MALFORMED_REQUEST_MESSAGE;
    case "unauthorized":
      return "Incorrect passcode.";
    case "rate-limited":
      return "Too many attempts. Wait before trying again.";
    case "network":
      return AUTH_STATUS_UNAVAILABLE_MESSAGE;
    default:
      return status === null ? "Request failed" : `Request failed (HTTP ${status})`;
  }
}

/**
 * Turns a non-2xx auth response into a typed error. The server's own message is
 * preferred for the cases where it is meaningful to an operator, but 415/503 use
 * the client copy above because the server text alone does not say what to do.
 */
export async function readAuthErrorResponse(
  response: Response,
  fallbackMessage?: string
): Promise<AuthRequestError> {
  const payload = (await response.json().catch(() => null)) as {
    error?: unknown;
    retryAfterMs?: unknown;
  } | null;
  const kind = classifyAuthStatusCode(response.status);
  const serverMessage = typeof payload?.error === "string" ? payload.error : null;
  const retryAfterMs =
    typeof payload?.retryAfterMs === "number" && payload.retryAfterMs > 0
      ? payload.retryAfterMs
      : null;

  let message: string;
  if (kind === "config-unavailable" || kind === "malformed-request") {
    // Deliberately client-side copy: actionable, and unmistakably not
    // "wrong passcode".
    message = defaultMessageForKind(kind, response.status);
  } else {
    message =
      serverMessage ??
      fallbackMessage ??
      defaultMessageForKind(kind, response.status);
  }

  return new AuthRequestError(kind, message, { status: response.status, retryAfterMs });
}

const UNAUTHORIZED_EVENT = "deckos:unauthorized";

export function emitUnauthorizedEvent() {
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

export function onUnauthorizedEvent(handler: () => void) {
  const listener = () => handler();
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => {
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  };
}

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    emitUnauthorizedEvent();
  }
  return response;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  let response: Response;
  try {
    response = await authFetch("/api/auth/status", {
      cache: "no-store",
    });
  } catch (error) {
    throw new AuthRequestError("network", AUTH_STATUS_UNAVAILABLE_MESSAGE, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw await readAuthErrorResponse(response, AUTH_STATUS_UNAVAILABLE_MESSAGE);
  }
  const payload = (await response.json().catch(() => null)) as Partial<AuthStatus> | null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AuthRequestError("server-error", AUTH_STATUS_UNAVAILABLE_MESSAGE, {
      status: response.status,
    });
  }
  return {
    enabled: payload.enabled === true,
    unlocked: payload.unlocked === true,
    sessionDurationMs:
      typeof payload.sessionDurationMs === "number" ? payload.sessionDurationMs : 0,
  };
}
