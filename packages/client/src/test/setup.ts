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
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  apiServer.close();
});
