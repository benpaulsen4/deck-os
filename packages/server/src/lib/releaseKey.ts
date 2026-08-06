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
 * The keypair has not been generated yet, so the constant below is still the
 * agreed sentinel. Verification is mandatory: the updater refuses to install
 * anything while the sentinel is in place rather than falling back to an
 * unverified install.
 */
export const RELEASE_PUBLIC_KEY_SENTINEL = "REPLACE_WITH_DECKOS_RELEASE_PUBLIC_KEY";

/**
 * ed25519 public key in PEM SPKI form.
 *
 * Replace with the output of:
 *   openssl pkey -in deckos-release-signing.key -pubout
 * and keep the copy inlined in `install.sh` identical.
 */
export const RELEASE_PUBLIC_KEY_PEM = "REPLACE_WITH_DECKOS_RELEASE_PUBLIC_KEY";

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
