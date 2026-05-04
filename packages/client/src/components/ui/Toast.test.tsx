import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

describe("Toast", () => {
  it("auto-closes after the configured duration", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast message="Saved" type="success" duration={1000} onClose={onClose} />);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pauses timeout on hover and resumes remaining duration on leave", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Toast message="Retrying" type="info" duration={1000} onClose={onClose} />);
    const toast = screen.getByText("Retrying").parentElement;

    expect(toast).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.mouseEnter(toast as HTMLElement);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not restart the timeout when onClose changes on re-render", () => {
    vi.useFakeTimers();
    const firstOnClose = vi.fn();
    const secondOnClose = vi.fn();
    const { rerender } = render(
      <Toast message="Docker failure" type="error" duration={1000} onClose={firstOnClose} />
    );

    act(() => {
      vi.advanceTimersByTime(400);
    });

    rerender(<Toast message="Docker failure" type="error" duration={1000} onClose={secondOnClose} />);

    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).toHaveBeenCalledTimes(1);
  });

  it("renders provided message", () => {
    render(<Toast message="Failure happened" type="error" onClose={vi.fn()} />);
    expect(screen.getByText("Failure happened")).toBeInTheDocument();
  });
});
