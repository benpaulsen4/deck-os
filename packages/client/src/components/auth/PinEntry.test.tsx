import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PinEntry } from "./PinEntry";

function PinEntryHost({
  initialValue = "",
  onSubmit,
}: {
  initialValue?: string;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <PinEntry
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      length={4}
      autoFocus
    />
  );
}

/**
 * The boxes are `type="password"` (masked), so they have no `textbox` role;
 * they are addressed by their per-digit accessible name instead.
 */
function getPinBoxes(): HTMLInputElement[] {
  return screen.getAllByLabelText(/^Passcode digit \d+ of \d+$/);
}

describe("PinEntry", () => {
  it("masks every digit so the passcode is not readable over a shoulder", () => {
    render(<PinEntryHost />);

    const inputs = getPinBoxes();
    expect(inputs).toHaveLength(4);
    for (const input of inputs) {
      expect(input).toHaveAttribute("type", "password");
    }
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("names the row and every box for screen readers", () => {
    render(<PinEntryHost />);

    expect(screen.getByRole("group", { name: "Passcode" })).toBeInTheDocument();
    const inputs = getPinBoxes();
    expect(inputs.map((input) => input.getAttribute("aria-label"))).toEqual([
      "Passcode digit 1 of 4",
      "Passcode digit 2 of 4",
      "Passcode digit 3 of 4",
      "Passcode digit 4 of 4",
    ]);
  });

  it("auto-focuses the first input and accepts only digits", async () => {
    const user = userEvent.setup();
    render(<PinEntryHost />);

    const inputs = getPinBoxes();
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toHaveFocus();

    await user.type(inputs[0], "a1");
    expect(inputs[0]).toHaveValue("1");
    expect(inputs[1]).toHaveFocus();
  });

  it("fills subsequent inputs when pasting digits", () => {
    render(<PinEntryHost />);
    const inputs = getPinBoxes();

    fireEvent.paste(inputs[1], {
      clipboardData: {
        getData: () => "9a876",
      },
    });

    expect(inputs[0]).toHaveValue("9");
    expect(inputs[1]).toHaveValue("8");
    expect(inputs[2]).toHaveValue("7");
    expect(inputs[3]).toHaveValue("");
  });

  it("backspace clears previous digit and moves focus when current is empty", async () => {
    const user = userEvent.setup();
    render(<PinEntryHost initialValue="12" />);
    const inputs = getPinBoxes();

    inputs[2].focus();
    await user.keyboard("{Backspace}");

    expect(inputs[1]).toHaveValue("");
    expect(inputs[1]).toHaveFocus();
  });

  it("submits when Enter is pressed and at least four digits exist", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PinEntryHost initialValue="1234" onSubmit={onSubmit} />);

    const inputs = getPinBoxes();
    inputs[3].focus();
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
