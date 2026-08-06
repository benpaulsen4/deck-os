import { act, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";

function getView(): EditorView {
  const dom = document.querySelector(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom as HTMLElement) : null;
  if (!view) {
    throw new Error("EditorView was not mounted");
  }
  return view;
}

/** Mimics the user typing: only user-annotated transactions reach `onChange`. */
function typeInto(view: EditorView, text: string) {
  act(() => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      annotations: Transaction.userEvent.of("input.type"),
    });
  });
}

describe("CodeEditor", () => {
  // CLI-10: the update listener outlives every render, so capturing `onChange`
  // directly pinned it to the handler that existed before the file content had
  // resolved -- one comparing edits against an empty baseline.
  it("calls the latest onChange, not the one captured when the view was built", () => {
    const firstOnChange = vi.fn();
    const laterOnChange = vi.fn();

    const { rerender } = render(<CodeEditor value="" onChange={firstOnChange} />);
    rerender(<CodeEditor value="" onChange={laterOnChange} />);

    typeInto(getView(), "services:");

    expect(laterOnChange).toHaveBeenCalledWith("services:");
    expect(firstOnChange).not.toHaveBeenCalled();
  });

  it("does not rebuild the EditorView when only onChange changes", () => {
    const { rerender } = render(<CodeEditor value="" onChange={vi.fn()} />);
    const viewBefore = getView();

    rerender(<CodeEditor value="" onChange={vi.fn()} />);

    expect(getView()).toBe(viewBefore);
  });

  it("reports an emptied document instead of treating it as unchanged", () => {
    const onChange = vi.fn();
    render(<CodeEditor value="version: 3" onChange={onChange} />);

    const view = getView();
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        annotations: Transaction.userEvent.of("delete.selection"),
      });
    });

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("ignores programmatic value updates so they are not echoed back as edits", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CodeEditor value="a" onChange={onChange} />);

    rerender(<CodeEditor value="b" onChange={onChange} />);

    expect(getView().state.doc.toString()).toBe("b");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not report edits while readonly", () => {
    const onChange = vi.fn();
    render(<CodeEditor value="" onChange={onChange} readonly />);

    typeInto(getView(), "x");

    expect(onChange).not.toHaveBeenCalled();
  });
});
