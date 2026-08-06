// Both projects must be listed here. With only the server config, running
// `vitest` from the repo root silently ran 161 of the 284 tests and reported
// green. CI never noticed because it invokes each package with --filter.
export default ["packages/server/vitest.config.ts", "packages/client/vitest.config.ts"];
