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

describe("PinEntry", () => {
  it("auto-focuses the first input and accepts only digits", async () => {
    const user = userEvent.setup();
    render(<PinEntryHost />);

    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toHaveFocus();

    await user.type(inputs[0], "a1");
    expect(inputs[0]).toHaveValue("1");
    expect(inputs[1]).toHaveFocus();
  });

  it("fills subsequent inputs when pasting digits", () => {
    render(<PinEntryHost />);
    const inputs = screen.getAllByRole("textbox");

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
    const inputs = screen.getAllByRole("textbox");

    inputs[2].focus();
    await user.keyboard("{Backspace}");

    expect(inputs[1]).toHaveValue("");
    expect(inputs[1]).toHaveFocus();
  });

  it("submits when Enter is pressed and at least four digits exist", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<PinEntryHost initialValue="1234" onSubmit={onSubmit} />);

    const inputs = screen.getAllByRole("textbox");
    inputs[3].focus();
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
