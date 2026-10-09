import { describe, expect, it } from "vitest";
import { OptionalWebUrlSchema, WebUrlOrEmptySchema } from "./schema.js";

describe("WebUrlOrEmptySchema", () => {
  it("accepts plain http(s) urls and the empty string", () => {
    expect(WebUrlOrEmptySchema.parse("https://example.com")).toBe("https://example.com");
    expect(WebUrlOrEmptySchema.parse("http://10.0.0.5:8080/admin")).toBe(
      "http://10.0.0.5:8080/admin"
    );
    expect(WebUrlOrEmptySchema.parse("")).toBe("");
  });

  it("accepts and preserves the DECKOS_HOST token", () => {
    expect(WebUrlOrEmptySchema.parse("http://{{DECKOS_HOST}}:8686")).toBe(
      "http://{{DECKOS_HOST}}:8686"
    );
    expect(OptionalWebUrlSchema.parse("https://{{DECKOS_HOST}}:8443/ui")).toBe(
      "https://{{DECKOS_HOST}}:8443/ui"
    );
  });

  it("rejects non-http schemes even with the token", () => {
    expect(WebUrlOrEmptySchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(WebUrlOrEmptySchema.safeParse("ftp://{{DECKOS_HOST}}:21").success).toBe(false);
  });

  it("rejects malformed urls", () => {
    expect(WebUrlOrEmptySchema.safeParse("not a url").success).toBe(false);
    expect(WebUrlOrEmptySchema.safeParse("http://{{DECKOS_HOST}}:notaport").success).toBe(
      false
    );
    expect(WebUrlOrEmptySchema.safeParse("http://{{OTHER}}:8080").success).toBe(false);
  });
});
