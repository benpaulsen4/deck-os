import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { lineNumbers } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const deckosHighlight = HighlightStyle.define([
  { tag: t.string, color: "var(--accent-primary)" },
  { tag: t.number, color: "var(--meter-cpu)" },
  { tag: t.bool, color: "var(--meter-memory)" },
  { tag: t.null, color: "var(--text-muted)" },
  { tag: t.propertyName, color: "var(--status-info)" },
  { tag: t.comment, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--text-primary)" },
  { tag: t.operator, color: "var(--text-primary)" },
  { tag: t.punctuation, color: "var(--text-secondary)" },
]);

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  readonly?: boolean;
  minHeight?: string;
}

export function CodeEditor({ value, onChange, readonly = false, minHeight = "300px" }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      lineNumbers(),
      EditorView.editable.of(!readonly),
      yaml(),
      syntaxHighlighting(deckosHighlight),
      EditorView.theme({
        "&": {
          backgroundColor: "var(--bg-primary)",
          color: "var(--text-primary)",
          fontSize: "var(--text-base)",
          fontFamily: "'JetBrains Mono', monospace",
        },
        ".cm-content": {
          padding: "var(--space-2)",
          minHeight,
        },
        ".cm-gutters": {
          backgroundColor: "var(--bg-secondary)",
          color: "var(--text-muted)",
          border: "1px solid var(--border-primary)",
          fontSize: "var(--text-xs)",
        },
        ".cm-lineNumbers": {
          color: "var(--text-muted)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--bg-tertiary)",
          color: "var(--text-primary)",
        },
        ".cm-line": {
          padding: 0,
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(0, 255, 136, 0.05)",
        },
        ".cm-scroller": {
          border: "1px solid var(--border-primary)",
          borderRadius: 0,
        },
        ".cm-focused": {
          outline: "none",
          borderColor: "var(--accent-primary)",
        },
        "&.cm-focused .cm-activeLine": {
          backgroundColor: "rgba(0, 255, 136, 0.08)",
        },
      }, { dark: true }),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !readonly) {
          onChange(update.state.doc.toString());
        }
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
  }, [readonly]);

  useEffect(() => {
    if (viewRef.current && value !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="code-editor" style={{ minHeight }} />;
}