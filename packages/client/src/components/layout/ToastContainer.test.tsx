import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../../stores/toast";
import { ToastContainer } from "./ToastContainer";

describe("ToastContainer", () => {
  beforeEach(() => {
    useToastStore.setState({
      toasts: [],
      addToast: useToastStore.getState().addToast,
      removeToast: useToastStore.getState().removeToast,
    });
  });

  it("renders toasts from the store", () => {
    useToastStore.setState({
      toasts: [
        { id: "1", message: "Saved changes", type: "success" },
        { id: "2", message: "Unable to sync", type: "error" },
      ],
    });

    render(<ToastContainer />);

    expect(screen.getByText("Saved changes")).toBeInTheDocument();
    expect(screen.getByText("Unable to sync")).toBeInTheDocument();
  });

  it("removes success toast after 3500ms", () => {
    vi.useFakeTimers();
    useToastStore.setState({
      toasts: [{ id: "1", message: "Done", type: "success" }],
    });
    render(<ToastContainer />);

    act(() => {
      vi.advanceTimersByTime(3499);
    });
    expect(useToastStore.getState().toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("keeps error toast until 12000ms", () => {
    vi.useFakeTimers();
    useToastStore.setState({
      toasts: [{ id: "1", message: "Critical failure", type: "error" }],
    });
    render(<ToastContainer />);

    act(() => {
      vi.advanceTimersByTime(11999);
    });
    expect(screen.getByText("Critical failure")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
