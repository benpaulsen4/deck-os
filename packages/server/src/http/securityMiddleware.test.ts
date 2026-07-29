import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  crossOriginGuard,
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
});
