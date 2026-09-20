import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { apiServer } from "./helpers/api";
import { installEventSourceMock, resetEventSourceMocks } from "./helpers/eventSource";

const nativeFetch = globalThis.fetch.bind(globalThis);

const testFetch: typeof fetch = (input, init) => {
  if (typeof input === "string" && input.startsWith("/")) {
    return nativeFetch(new URL(input, window.location.origin), init);
  }
  if (input instanceof URL && input.pathname.startsWith("/")) {
    return nativeFetch(input, init);
  }
  return nativeFetch(input, init);
};

beforeAll(() => {
  installEventSourceMock();
  vi.stubGlobal("fetch", testFetch);
  apiServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  apiServer.resetHandlers();
  resetEventSourceMocks();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  vi.restoreAllMocks();
  // resetAllMocks, not clearAllMocks: vitest 4 narrowed restoreAllMocks to
  // spies, so a plain vi.fn() keeps its implementation into the next test
  // unless it is reset. clearAllMocks only drops call history.
  vi.resetAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  apiServer.close();
});
