/**
 * Placeholder an app's web URL may use in place of a hostname. It is stored
 * verbatim and resolved against whatever host DeckOS is being viewed on, so a
 * shortcut like `http://{{DECKOS_HOST}}:8686` works from localhost, a LAN IP
 * or a tailnet name alike.
 */
const DECKOS_HOST_TOKEN = "{{DECKOS_HOST}}";

// This package compiles against plain ES2022 with no DOM or Node typings, but
// both runtimes that consume it provide the WHATWG URL global.
declare const URL: new (input: string) => { protocol: string };

function formatHostForUrl(hostname: string): string {
  // `location.hostname` brackets IPv6 in browsers, but a bare address would
  // otherwise turn `[::1]:8686` into an unparseable `::1:8686`.
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

/**
 * Substitutes {@link DECKOS_HOST_TOKEN} with `hostname` and returns the result
 * only if it is a valid http(s) URL; anything else resolves to "".
 */
function resolveAppUrl(raw: string, hostname: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const resolved = trimmed.split(DECKOS_HOST_TOKEN).join(formatHostForUrl(hostname));
  // WHATWG URL accepts braces in a hostname, so a mistyped token would
  // otherwise slip through as a literal host.
  if (/\{\{.*\}\}/.test(resolved)) return "";
  try {
    const { protocol } = new URL(resolved);
    return protocol === "http:" || protocol === "https:" ? resolved : "";
  } catch {
    return "";
  }
}

export { DECKOS_HOST_TOKEN, resolveAppUrl };
