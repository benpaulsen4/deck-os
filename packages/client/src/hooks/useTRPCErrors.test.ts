import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatTRPCError, useTRPCErrors, type TRPCAppError } from "./useTRPCErrors";
import { useToastStore } from "../stores/toast";

describe("useTRPCErrors", () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.restoreAllMocks();
  });

  it("adds a toast and logs when error includes path", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error: TRPCAppError = {
      message: "Request failed",
      data: { path: "apps.list", httpStatus: 500 },
    };

    renderHook(({ value }) => useTRPCErrors(value), { initialProps: { value: error } });

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    const toast = useToastStore.getState().toasts[0];
    expect(toast?.message).toBe("Error in apps.list: Request failed");
    expect(toast?.type).toBe("error");
    expect(consoleErrorSpy).toHaveBeenCalledWith("tRPC Error:", error);
  });

  it("does nothing when error is null", () => {
    renderHook(() => useTRPCErrors(null));
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});

describe("formatTRPCError", () => {
  it("returns empty text for null error", () => {
    expect(formatTRPCError(null)).toBe("");
  });

  it("formats with path when available", () => {
    expect(formatTRPCError({ message: "Broken", data: { path: "docker.getStatus" } })).toBe(
      "docker.getStatus: Broken"
    );
  });

  it("returns message only when path is missing", () => {
    expect(formatTRPCError({ message: "Broken" })).toBe("Broken");
  });
});
