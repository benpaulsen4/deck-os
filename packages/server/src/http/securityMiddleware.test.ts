import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  crossOriginGuard,
  registerSecurityMiddleware,
  requireJsonBodyForTrpcWrites,
  securityHeaders,
} from "./securityMiddleware.js";

const ORIGINAL_ALLOWED_ORIGINS = process.env.DECKOS_ALLOWED_ORIGINS;

afterEach(() => {
  if (ORIGINAL_ALLOWED_ORIGINS === undefined) {
    delete process.env.DECKOS_ALLOWED_ORIGINS;
  } else {
    process.env.DECKOS_ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
  }
});

function guardedApp() {
  const app = new Hono();
  app.use("*", crossOriginGuard());
  app.get("/api/files/download", (c) => c.json({ ok: true }));
  app.post("/api/files/upload", (c) => c.json({ ok: true }));
  app.post("/api/trpc/system.applyUpdate", (c) => c.json({ ok: true }));
  app.post("/api/auth/configure", (c) => c.json({ ok: true }));
  return app;
}

describe("crossOriginGuard", () => {
  test("blocks a cross-site multipart upload, the CSRF-writable path", async () => {
    const res = await guardedApp().request(
      "http://deckos.lan:3000/api/files/upload?path=/etc",
      {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "content-type": "multipart/form-data; boundary=x",
        },
        body: "--x--",
      }
    );

    expect(res.status).toBe(403);
    const payload = (await res.json()) as { error?: string };
    expect(payload.error).toContain("Cross-origin request blocked");
  });

  test("blocks a cross-site form post to a tRPC mutation", async () => {
    const res = await guardedApp().request(
      "http://deckos.lan:3000/api/trpc/system.applyUpdate",
      {
        method: "POST",
        headers: {
          Origin: "http://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "input=%7B%7D",
      }
    );

    expect(res.status).toBe(403);
  });

  test("blocks cross-site passcode setup on a default (unlocked) install", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/auth/configure", {
      method: "POST",
      headers: { Origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ passcode: "0000", sessionDurationMs: 3_600_000 }),
    });

    expect(res.status).toBe(403);
  });

  test("treats a different port on the same host as cross-origin", async () => {
    // Homelab boxes run other apps on the same hostname; those must not be able
    // to drive the panel.
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/upload", {
      method: "POST",
      headers: { Origin: "http://deckos.lan:8080" },
    });

    expect(res.status).toBe(403);
  });

  test("allows a same-origin write", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/upload", {
      method: "POST",
      headers: { Origin: "http://deckos.lan:3000" },
    });

    expect(res.status).toBe(200);
  });

  test("ignores the scheme so TLS termination by a reverse proxy still works", async () => {
    const res = await guardedApp().request("http://deckos.lan/api/files/upload", {
      method: "POST",
      headers: { Origin: "https://deckos.lan" },
    });

    expect(res.status).toBe(200);
  });

  test("allows an origin listed in DECKOS_ALLOWED_ORIGINS", async () => {
    process.env.DECKOS_ALLOWED_ORIGINS = "https://panel.example.com, other.example";

    const res = await guardedApp().request("http://127.0.0.1:3000/api/files/upload", {
      method: "POST",
      headers: { Origin: "https://panel.example.com" },
    });

    expect(res.status).toBe(200);
  });

  describe("Host allowlist (only active when DECKOS_ALLOWED_ORIGINS is set)", () => {
    test("no Host checking at all by default, so nothing can be bricked", async () => {
      const res = await guardedApp().request(
        "http://anything.attacker.example/api/files/upload",
        {
          method: "POST",
          headers: { Origin: "http://anything.attacker.example" },
        }
      );

      expect(res.status).toBe(200);
    });

    test("blocks a rebound hostname once the operator has opted in", async () => {
      process.env.DECKOS_ALLOWED_ORIGINS = "https://panel.example.com";

      // Under DNS rebinding Origin and Host agree -- both are the attacker's
      // name -- so only the Host allowlist catches this.
      const res = await guardedApp().request(
        "http://rebind.attacker.example/api/files/upload",
        {
          method: "POST",
          headers: { Origin: "http://rebind.attacker.example" },
        }
      );

      expect(res.status).toBe(403);
      const payload = (await res.json()) as { error?: string };
      expect(payload.error).toContain("DECKOS_ALLOWED_ORIGINS");
    });

    test("still accepts the listed host", async () => {
      process.env.DECKOS_ALLOWED_ORIGINS = "https://panel.example.com";

      const res = await guardedApp().request(
        "http://panel.example.com/api/files/upload",
        {
          method: "POST",
          headers: { Origin: "https://panel.example.com" },
        }
      );

      expect(res.status).toBe(200);
    });

    test("still accepts a bare IP or localhost, which cannot be rebound", async () => {
      process.env.DECKOS_ALLOWED_ORIGINS = "https://panel.example.com";

      for (const host of ["192.168.1.50:3000", "localhost:3000"]) {
        const res = await guardedApp().request(`http://${host}/api/files/upload`, {
          method: "POST",
          headers: { Origin: `http://${host}` },
        });
        expect(res.status).toBe(200);
      }
    });
  });

  test("allows requests with no Origin header so CLI clients keep working", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/upload", {
      method: "POST",
    });

    expect(res.status).toBe(200);
  });

  test("blocks an Origin-less request that the browser marks cross-site", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/upload", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });

    expect(res.status).toBe(403);
  });

  test("rejects an opaque origin", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/upload", {
      method: "POST",
      headers: { Origin: "null" },
    });

    expect(res.status).toBe(403);
  });

  test("never blocks safe methods", async () => {
    const res = await guardedApp().request("http://deckos.lan:3000/api/files/download", {
      headers: { Origin: "https://evil.example" },
    });

    expect(res.status).toBe(200);
  });
});

describe("requireJsonBodyForTrpcWrites", () => {
  function app() {
    const instance = new Hono();
    instance.use("/api/trpc/*", requireJsonBodyForTrpcWrites());
    instance.all("/api/trpc/system.applyUpdate", (c) => c.json({ ok: true }));
    return instance;
  }

  test("rejects a multipart body, which zod's z.object({}) would accept", async () => {
    const res = await app().request("http://deckos.lan/api/trpc/system.applyUpdate", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x--",
    });

    expect(res.status).toBe(415);
  });

  test("accepts the JSON body the tRPC client sends", async () => {
    const res = await app().request("http://deckos.lan/api/trpc/system.applyUpdate", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });

    expect(res.status).toBe(200);
  });

  test("leaves queries (GET) alone", async () => {
    const res = await app().request("http://deckos.lan/api/trpc/system.applyUpdate");

    expect(res.status).toBe(200);
  });
});

describe("securityHeaders", () => {
  test("sets clickjacking and sniffing protections without a script policy", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (c) => c.html("<html lang='en'></html>"));

    const res = await app.request("http://deckos.lan/");

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    // Only `frame-ancestors`: a script-src/style-src policy would break the
    // Vite + CodeMirror SPA.
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBe("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("style-src");
  });

  test("still sets them on the 500 produced by a throwing handler", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/boom", () => {
      throw new Error("kaboom");
    });

    const res = await app.request("http://deckos.lan/boom");

    expect(res.status).toBe(500);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });

  test("sets them on a 404 from the not-found handler", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());

    const res = await app.request("http://deckos.lan/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("registerSecurityMiddleware", () => {
  test("installs headers, the origin guard and the tRPC body check together", async () => {
    const app = new Hono();
    registerSecurityMiddleware(app);
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.post("/api/files/upload", (c) => c.json({ ok: true }));
    app.post("/api/trpc/system.applyUpdate", (c) => c.json({ ok: true }));

    const health = await app.request("http://deckos.lan/api/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("X-Frame-Options")).toBe("DENY");

    const crossSite = await app.request("http://deckos.lan/api/files/upload", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);

    const formToTrpc = await app.request("http://deckos.lan/api/trpc/system.applyUpdate", {
      method: "POST",
      headers: {
        Origin: "http://deckos.lan",
        "content-type": "multipart/form-data; boundary=x",
      },
      body: "--x--",
    });
    expect(formToTrpc.status).toBe(415);
  });
});
