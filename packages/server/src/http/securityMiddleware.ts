import type { MiddlewareHandler } from "hono";

/**
 * Methods that cannot change server state on their own. `Origin` is not checked
 * for these so that plain browsing, SSE streams and downloads keep working.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_ORIGINS_ENV = "DECKOS_ALLOWED_ORIGINS";

function parseHostFromOrigin(origin: string): string | null {
  if (origin === "null") {
    // Opaque origin (sandboxed iframe, `file://` document). Never same-origin.
    return null;
  }
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function getRequestHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extra hosts/origins accepted in addition to the request's own `Host`.
 * Needed when a reverse proxy rewrites `Host` (nginx's `proxy_pass` default)
 * so that the browser `Origin` no longer matches what the server sees.
 */
function getConfiguredAllowedHosts(): Set<string> {
  const raw = process.env[ALLOWED_ORIGINS_ENV];
  const hosts = new Set<string>();
  if (!raw) {
    return hosts;
  }
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) {
      continue;
    }
    const host = value.includes("://") ? parseHostFromOrigin(value) : value.toLowerCase();
    if (host) {
      hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Rejects state-changing requests that a browser reports as coming from another
 * origin.
 *
 * DeckOS has no CORS layer, which means the browser never blocks the *sending*
 * of a "simple" cross-site request; it only hides the response. A plain HTML
 * form posting `multipart/form-data` therefore reaches `/api/files/upload` and
 * `/api/trpc/*` today, and with the passcode lock off (the default) it is
 * executed. Comparing `Origin` against the request's own `Host` is the standard
 * defence and needs no shared secret.
 *
 * Requests without an `Origin` header (curl, scripts, same-origin GETs) are
 * allowed through: browsers always attach `Origin` to cross-site form posts and
 * to `fetch`/XHR, so their absence is not an attack signal, and requiring it
 * would break every non-browser client.
 */
export function crossOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    const requestHost = getRequestHost(c.req.url);

    if (origin) {
      const originHost = parseHostFromOrigin(origin);
      const allowed =
        (originHost !== null && originHost === requestHost) ||
        (originHost !== null && getConfiguredAllowedHosts().has(originHost));
      if (!allowed) {
        return c.json(
          {
            error:
              "Cross-origin request blocked. If DeckOS is behind a reverse proxy that " +
              `rewrites the Host header, list the browser-facing origin in ${ALLOWED_ORIGINS_ENV}.`,
          },
          403
        );
      }
    } else if (c.req.header("sec-fetch-site") === "cross-site") {
      // Browser-only signal; covers the rare request that omits `Origin`.
      return c.json({ error: "Cross-origin request blocked." }, 403);
    }

    await next();
  };
}

/**
 * The tRPC handler accepts non-JSON bodies, and a `FormData` instance satisfies
 * `z.object({})`, so a cross-site HTML form can otherwise invoke a mutation
 * such as `system.applyUpdate` as a CORS "simple request" (no preflight, and
 * therefore no chance for the browser to block it). Requiring a JSON
 * content-type on tRPC writes removes that path entirely; `httpBatchLink`
 * always sends `application/json`.
 */
export function requireJsonBodyForTrpcWrites(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
    if (contentType?.toLowerCase() !== "application/json") {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }
    await next();
  };
}

/**
 * Conservative response headers.
 *
 * The SPA is a Vite build that uses CodeMirror and inline styles, so no
 * `script-src`/`style-src` policy is set — only `frame-ancestors`, which is the
 * directive that carries the clickjacking value (Start/Stop/Delete/Shutdown are
 * all single-click actions) and cannot affect how the bundle loads.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // Mirrors how Hono's own `secureHeaders` writes headers after the handler.
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  };
}
