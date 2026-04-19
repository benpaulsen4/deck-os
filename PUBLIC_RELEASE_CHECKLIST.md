# Public Release Checklist

This checklist tracks the work needed before making the DeckOS repository public.

## 1. Update Mechanism

Goal: ship one private release that preserves updates for already-deployed private instances, then remove private-only GitHub assumptions in a later release.

- [x] Audit the current update flow end to end (`release checks`, `download`, `upgrade`, and failure handling).
- [x] Confirm the exact behavior when `DECKOS_GITHUB_TOKEN` is missing for release checks and update downloads.
- [x] Update release-check logic to support public GitHub Releases without requiring a token.
- [x] Keep token support working for existing private deployments during the transition release.
- [ ] Verify that deployed private instances can still check for and install the transitional private release.
- [x] Add explicit fallback behavior: anonymous GitHub access first when possible, token only when needed.
- [ ] Decide whether private-release download/install should continue requiring a token until the public cutover release.
- [ ] Ship a private transition release that introduces token-optional release checking.
- [ ] After that release is deployed, remove private-repo-only mechanisms in a separate release.
- [ ] Remove token-dependent wording from install/update docs only after the public-release behavior is live.
- [x] Add regression coverage for update checks with and without `DECKOS_GITHUB_TOKEN`.

Verification:

- [ ] Existing deployed private instances still detect updates correctly.
- [x] Public-release checks work with no token configured.
- [x] Failure messages are clear when authentication is actually required.

## 2. Vulnerabilities

Goal: get automated dependency maintenance in place and clean up security issues before public launch.

- [ ] Configure Dependabot for GitHub Actions and npm dependencies.
- [ ] Review the current `pnpm audit --prod` findings and group them into direct vs transitive dependencies.
- [ ] Prioritize fixes for the critical/high findings affecting `protobufjs`, `systeminformation`, `hono`, and `@hono/node-server`.
- [ ] Merge or manually apply the first safe dependency upgrade set if automation does not clear everything quickly enough.
- [ ] Re-run `pnpm audit --prod` after upgrades and confirm the remaining risk is acceptable.
- [ ] Review shipped templates for hardcoded secrets/default credentials and decide whether to fix them before public launch.

Verification:

- [ ] Dependabot is enabled and opening update PRs.
- [ ] Critical/high production advisories are resolved or consciously accepted.

## 3. CI

Goal: make sure breakage is caught even if code lands without a pull request.

- [ ] Add `push` handling to the CI workflow for the default branch.
- [ ] Confirm that CI still runs on pull requests and manual dispatch.
- [ ] Decide whether Node support is truly `20+` or `24`, then align CI with the supported version policy.
- [ ] Decide whether `test:e2e` belongs in CI now or later.
- [ ] Confirm release workflow expectations still match CI behavior.

Verification:

- [ ] A direct push to the default branch triggers CI.
- [ ] CI status remains green for lint, typecheck, tests, and build.

## 4. Documentation

Goal: replace internal/design-oriented docs with public-facing user documentation.

- [ ] Remove the current design/planning docs from `docs/`.
- [ ] Define the structure for a small user wiki in `docs/`.
- [ ] Rewrite the root `README.md` for public users.
- [ ] Document installation for the public-release path.
- [ ] Document updating, rollback, and uninstall in public-facing terms.
- [ ] Document security expectations clearly, especially Docker socket access and trusted-network assumptions.
- [ ] Add user-facing guides for common workflows such as creating an app, managing containers, and using templates.
- [ ] Add troubleshooting pages for common install and runtime problems.
- [ ] Review all docs for private-repo language, internal assumptions, and stale implementation details.

Verification:

- [ ] `README.md` stands on its own for first-time users.
- [ ] `docs/` contains only user-facing content you are comfortable publishing.

## 5. License And Public Repo Files

Goal: finish the public-facing repository polish after the functional work above is complete.

- [ ] Add the chosen license file.
- [ ] Add `SECURITY.md`.
- [ ] Add `CONTRIBUTING.md`.
- [ ] Add `CODE_OF_CONDUCT.md` if desired.
- [ ] Add `CODEOWNERS` if desired.
- [ ] Add repository metadata such as homepage, bugs URL, and license fields where appropriate.

Verification:

- [ ] The repo has the minimum public-facing legal and contribution files you want before launch.

## Pre-Public Go/No-Go

- [ ] Update transition release has shipped successfully.
- [ ] Dependency maintenance is automated.
- [ ] CI covers the default branch.
- [ ] Docs are rewritten for public users.
- [ ] License/public repo files are present.
- [ ] Final repo audit is complete before toggling visibility.
