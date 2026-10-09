import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppLaunchUrl } from "./appUrl";

describe("getAppLaunchUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns plain http(s) urls unchanged", () => {
    expect(getAppLaunchUrl("https://example.com")).toBe("https://example.com");
    expect(getAppLaunchUrl("  http://example.com:8080/x  ")).toBe(
      "http://example.com:8080/x"
    );
  });

  it("substitutes the DECKOS_HOST token with the current hostname", () => {
    // jsdom is configured with url http://localhost:5173
    expect(getAppLaunchUrl("http://{{DECKOS_HOST}}:8686")).toBe("http://localhost:8686");
    expect(getAppLaunchUrl("https://{{DECKOS_HOST}}:8443/admin")).toBe(
      "https://localhost:8443/admin"
    );
  });

  it("uses whatever host DeckOS is being viewed on", () => {
    vi.stubGlobal("location", { hostname: "deck.tail1234.ts.net" });
    expect(getAppLaunchUrl("http://{{DECKOS_HOST}}:8686")).toBe(
      "http://deck.tail1234.ts.net:8686"
    );
  });

  it("brackets bare IPv6 hostnames", () => {
    vi.stubGlobal("location", { hostname: "fd7a:115c:a1e0::1" });
    expect(getAppLaunchUrl("http://{{DECKOS_HOST}}:8686")).toBe(
      "http://[fd7a:115c:a1e0::1]:8686"
    );
    vi.stubGlobal("location", { hostname: "[::1]" });
    expect(getAppLaunchUrl("http://{{DECKOS_HOST}}:8686")).toBe("http://[::1]:8686");
  });

  it("returns empty string for empty, unsafe, or malformed urls", () => {
    expect(getAppLaunchUrl("")).toBe("");
    expect(getAppLaunchUrl(undefined)).toBe("");
    expect(getAppLaunchUrl("javascript:alert(1)")).toBe("");
    expect(getAppLaunchUrl("http://{{DECKOS_HOST}}:notaport")).toBe("");
    expect(getAppLaunchUrl("not a url")).toBe("");
  });
});
