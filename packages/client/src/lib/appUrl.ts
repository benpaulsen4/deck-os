import { DECKOS_HOST_TOKEN, resolveAppUrl } from "@deckos/contracts";

export const APP_URL_HINT = `${DECKOS_HOST_TOKEN} = the address you're viewing DeckOS on`;

/** The app's launch URL resolved against the host DeckOS is being viewed on. */
export function getAppLaunchUrl(raw: string | undefined): string {
  return typeof raw === "string" ? resolveAppUrl(raw, window.location.hostname) : "";
}
