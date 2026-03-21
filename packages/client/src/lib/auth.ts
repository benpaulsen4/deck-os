export type AuthStatus = {
  enabled: boolean;
  unlocked: boolean;
  sessionDurationMs: number;
};

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
  const response = await authFetch("/api/auth/status", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to read auth status");
  }
  const payload = (await response.json()) as Partial<AuthStatus>;
  return {
    enabled: payload.enabled === true,
    unlocked: payload.unlocked === true,
    sessionDurationMs:
      typeof payload.sessionDurationMs === "number" ? payload.sessionDurationMs : 0,
  };
}
