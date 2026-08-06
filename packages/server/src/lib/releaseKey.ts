/**
 * Public half of the DeckOS release signing keypair.
 *
 * Release integrity scheme (must match `install.sh` and `.github/workflows/release.yml`
 * byte for byte):
 *
 *   - every release publishes the tarball, a `SHA256SUMS` manifest in standard
 *     `sha256sum` format (`"<64-hex>  <filename>"`, one line per artifact), and
 *     `SHA256SUMS.sig`, a **raw 64-byte** ed25519 signature over the exact bytes
 *     of `SHA256SUMS`;
 *   - the private key lives only in the GitHub Actions secret
 *     `DECKOS_RELEASE_SIGNING_KEY` (PEM PKCS#8);
 *   - the public key below is PEM SPKI and is embedded in two places that MUST stay
 *     byte-identical: here, and inline in `install.sh` (which is fetched standalone
 *     via `curl | bash` and therefore cannot read files out of the repository).
 *
 * Verification is mandatory: while the key below is the sentinel the updater
 * refuses to install anything rather than falling back to an unverified
 * install. The sentinel constant itself must stay a literal - it is what
 * `isPlaceholderReleaseKey` compares against, so it survives the ceremony.
 */
export const RELEASE_PUBLIC_KEY_SENTINEL = "REPLACE_WITH_DECKOS_RELEASE_PUBLIC_KEY";

/**
 * ed25519 public key in PEM SPKI form, generated 2026-08-06.
 *
 * Produced by:
 *   openssl genpkey -algorithm ed25519 -out deckos-release.key
 *   openssl pkey -in deckos-release.key -pubout
 *
 * Written with explicit `\n` escapes rather than a template literal so that
 * reindenting this file can never inject leading whitespace into the PEM. The
 * same key is inlined in `install.sh`, which is fetched standalone via
 * `curl | bash` and so cannot read it from here - the two MUST stay identical.
 */
export const RELEASE_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MCowBQYDK2VwAyEAnwysTGZxSPefWzF3LBCdUcihmBM9rVTYVmfaCp+FEcw=\n" +
  "-----END PUBLIC KEY-----\n";

export const RELEASE_KEY_NOT_CONFIGURED_MESSAGE = [
  "Release signature verification is not configured:",
  `the release signing public key is still the placeholder "${RELEASE_PUBLIC_KEY_SENTINEL}".`,
  "Generate the keypair with `openssl genpkey -algorithm ed25519 -out deckos-release-signing.key`,",
  "store the private key in the GitHub Actions secret DECKOS_RELEASE_SIGNING_KEY,",
  "then paste `openssl pkey -in deckos-release-signing.key -pubout` into",
  "RELEASE_PUBLIC_KEY_PEM in packages/server/src/lib/releaseKey.ts and into install.sh.",
  "Updates are refused until a real key is in place.",
].join(" ");

/** True while the compiled-in key is the sentinel (or empty). */
export function isPlaceholderReleaseKey(publicKeyPem: string): boolean {
  const trimmed = publicKeyPem.trim();
  return trimmed.length === 0 || trimmed.includes(RELEASE_PUBLIC_KEY_SENTINEL);
}

/**
 * Throws an actionable error when the release signing key has not been replaced.
 * Callers must never downgrade this to a warning: an unsigned release must not be
 * installable.
 */
export function assertReleaseKeyConfigured(publicKeyPem: string): void {
  if (isPlaceholderReleaseKey(publicKeyPem)) {
    throw new Error(RELEASE_KEY_NOT_CONFIGURED_MESSAGE);
  }
}
