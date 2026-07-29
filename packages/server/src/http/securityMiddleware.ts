import type { Hono, MiddlewareHandler } from "hono";

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
 * A bare IP literal or loopback name cannot be the target of DNS rebinding:
 * there is no name for the attacker to re-point.
 */
function isRebindingSafeHost(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? "");
  if (hostname === "localhost") {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
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
 * allowed through: current browsers always attach `Origin` to cross-site form
 * posts and to `fetch`/XHR, so its absence is not an attack signal, and
 * requiring it would break every non-browser client.
 *
 * Caveat on that assumption: WebKit historically omitted `Origin` on cross-site
 * form submissions, and `Sec-Fetch-Site` (the fallback signal below) only
 * shipped in Safari 16.4. A pre-16.4 Safari is therefore not covered by either
 * check. Requiring `Origin` outright is the only way to close that, and it would
 * break every scripted client, so the trade is made deliberately.
 */
export function crossOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const origin = c.req.header("origin");
    const requestHost = getRequestHost(c.req.url);
    const allowedHosts = getConfiguredAllowedHosts();

    // DNS rebinding survives an Origin-vs-Host comparison, because under
    // rebinding both are the attacker's own hostname. Checking `Host` against an
    // allowlist is what closes it -- but a wrong allowlist bricks the panel, so
    // this only engages when the operator has opted in by setting the variable,
    // and it still accepts bare IP literals and localhost (an attacker cannot
    // point a DNS name at an IP literal, so those are not rebindable).
    if (allowedHosts.size > 0 && requestHost !== null) {
      if (!allowedHosts.has(requestHost) && !isRebindingSafeHost(requestHost)) {
        return c.json(
          {
            error:
              `Request rejected: Host "${requestHost}" is not listed in ${ALLOWED_ORIGINS_ENV}. ` +
              "Add it, or unset the variable to accept any Host.",
          },
          403
        );
      }
    }

    if (origin) {
      const originHost = parseHostFromOrigin(origin);
      const allowed =
        originHost !== null &&
        (originHost === requestHost || allowedHosts.has(originHost));
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
const RESPONSE_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Content-Security-Policy", "frame-ancestors 'none'"],
];

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    // Staged *before* the handler runs so they land in Hono's prepared headers
    // and are therefore merged into responses this middleware never gets to
    // touch -- in particular the 500 that Hono's error handler builds when a
    // downstream route throws. Setting them only after `next()` (as Hono's own
    // `secureHeaders` does) leaves error responses bare.
    for (const [name, value] of RESPONSE_SECURITY_HEADERS) {
      c.header(name, value);
    }
    try {
      await next();
    } finally {
      // And again afterwards, to cover a handler that returned a raw `Response`
      // rather than building one through the context.
      if (c.finalized) {
        for (const [name, value] of RESPONSE_SECURITY_HEADERS) {
          c.res.headers.set(name, value);
        }
      }
    }
  };
}

/**
 * Installs the guards in the one order that works. Hono runs handlers in
 * registration order, so this must be called before any route it protects is
 * registered. Exported so `index.ts` and the integration tests share a single
 * definition of the wiring instead of restating it.
 */
export function registerSecurityMiddleware(app: Hono) {
  app.use("*", securityHeaders());
  app.use("*", crossOriginGuard());
  app.use("/api/trpc/*", requireJsonBodyForTrpcWrites());
}
