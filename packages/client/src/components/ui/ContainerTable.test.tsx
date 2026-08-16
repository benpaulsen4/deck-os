import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContainerTable } from "./ContainerTable";
import { APP_BUSY_TITLE } from "../../hooks/useTRPCErrors";

function buildUnknownContainer(overrides: Partial<Parameters<typeof ContainerTable>[0]["containers"][number]> = {}) {
  return {
    id: "abc123",
    names: ["/mystery"],
    image: "unknown:latest",
    imageId: "sha256:xyz",
    created: 0,
    state: {
      status: "removed",
      running: false,
      paused: false,
      restarting: false,
      dead: false,
      pid: 0,
    },
    status: "removed",
    ...overrides,
  };
}

describe("ContainerTable", () => {
  // #18 gated the rest of the app-lifecycle group (start/stop/restart/delete)
  // on isAppBusy, but the remove-unknown-container button here still disabled
  // only on its own pending state -- a click during an in-flight start could
  // take a CONFLICT.
  it("disables and titles the remove-unknown-container button while the app is busy", () => {
    render(
      <ContainerTable
        containers={[buildUnknownContainer()]}
        onRemoveUnknownContainer={vi.fn()}
        appBusy
      />
    );

    const removeButton = screen.getByRole("button", { name: "REMOVE" });
    expect(removeButton).toBeDisabled();
    expect(removeButton).toHaveAttribute("title", APP_BUSY_TITLE);
  });

  it("keeps the remove-unknown-container button enabled when the app is idle", () => {
    render(
      <ContainerTable containers={[buildUnknownContainer()]} onRemoveUnknownContainer={vi.fn()} />
    );

    const removeButton = screen.getByRole("button", { name: "REMOVE" });
    expect(removeButton).not.toBeDisabled();
    expect(removeButton).not.toHaveAttribute("title");
  });

  it("still disables the remove button for its own pending removal, independent of appBusy", () => {
    render(
      <ContainerTable
        containers={[buildUnknownContainer()]}
        onRemoveUnknownContainer={vi.fn()}
        removingContainerId="abc123"
      />
    );

    expect(screen.getByRole("button", { name: "REMOVING" })).toBeDisabled();
  });
});
