import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toast";

describe("useToastStore", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it("adds toasts with default and explicit types", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const store = useToastStore.getState();

    store.addToast("hello");
    store.addToast("boom", "error");

    expect(useToastStore.getState().toasts).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", message: "hello", type: "info" },
      { id: "22222222-2222-4222-8222-222222222222", message: "boom", type: "error" },
    ]);
  });

  it("removes toast by id", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const store = useToastStore.getState();

    store.addToast("one");
    store.addToast("two");
    store.removeToast("11111111-1111-4111-8111-111111111111");

    expect(useToastStore.getState().toasts).toEqual([
      { id: "22222222-2222-4222-8222-222222222222", message: "two", type: "info" },
    ]);
  });
});
