import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

function renderConfirmDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const props: React.ComponentProps<typeof ConfirmDialog> = {
    isOpen: true,
    title: "Confirm action",
    message: "This action cannot be undone",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...render(<ConfirmDialog {...props} />), props };
}

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = renderConfirmDialog({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders title, message, and action buttons when open", () => {
    renderConfirmDialog({ confirmText: "DELETE", cancelText: "KEEP" });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Confirm action")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "DELETE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "KEEP" })).toBeInTheDocument();
  });

  it("calls confirm and cancel handlers from their buttons", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderConfirmDialog({ onConfirm, onCancel });

    await user.click(screen.getByRole("button", { name: "CONFIRM" }));
    await user.click(screen.getByRole("button", { name: "CANCEL" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls cancel from close button and Escape key", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderConfirmDialog({ onCancel });

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("uses danger variant for confirm button by default", () => {
    renderConfirmDialog();
    expect(screen.getByRole("button", { name: "CONFIRM" })).toHaveAttribute(
      "data-variant",
      "danger"
    );
  });
});
