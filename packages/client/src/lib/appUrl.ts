import { resolveAppUrl } from "@deckos/contracts";

/** The app's launch URL resolved against the host DeckOS is being viewed on. */
export function getAppLaunchUrl(raw: string | undefined): string {
  return typeof raw === "string" ? resolveAppUrl(raw, window.location.hostname) : "";
}
