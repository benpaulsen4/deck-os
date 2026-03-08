import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState, Transaction } from "@codemirror/state";
import { lineNumbers } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { HighlightStyle, syntaxHighlighting, StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { tags as t } from "@lezer/highlight";

const deckosHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--accent-primary)", fontWeight: "700" },
  { tag: t.heading1, color: "var(--accent-primary)", fontWeight: "700" },
  { tag: t.heading2, color: "var(--status-info)", fontWeight: "700" },
  { tag: t.heading3, color: "var(--status-info)" },
  { tag: t.strong, fontWeight: "700", color: "var(--text-primary)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--text-primary)" },
  { tag: t.link, color: "var(--status-info)", textDecoration: "underline" },
  { tag: t.url, color: "var(--status-info)" },
  { tag: t.monospace, color: "var(--accent-primary)" },
  { tag: t.quote, color: "var(--text-secondary)", fontStyle: "italic" },
  { tag: t.list, color: "var(--text-secondary)" },
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
  height?: string;
  language?:
    | "yaml"
    | "javascript"
    | "typescript"
    | "css"
    | "html"
    | "xml"
    | "markdown"
    | "python"
    | "sql"
    | "shell"
    | "powershell"
    | "plain";
}

export function CodeEditor({
  value,
  onChange,
  readonly = false,
  minHeight = "300px",
  height,
  language = "yaml",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      lineNumbers(),
      EditorView.editable.of(!readonly),
      syntaxHighlighting(deckosHighlight),
      EditorView.theme(
        {
          "&": {
            backgroundColor: "var(--bg-primary)",
            color: "var(--text-primary)",
            fontSize: "var(--text-base)",
            fontFamily: "'JetBrains Mono', monospace",
            height: height ?? "auto",
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
            overflow: "auto",
            height: "100%",
          },
          ".cm-focused": {
            outline: "none",
            borderColor: "var(--accent-primary)",
          },
          "&.cm-focused .cm-activeLine": {
            backgroundColor: "rgba(0, 255, 136, 0.08)",
          },
        },
        { dark: true }
      ),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      EditorView.updateListener.of((update) => {
        const changedByUser = update.transactions.some((transaction) => {
          const userEvent = transaction.annotation(Transaction.userEvent);
          return typeof userEvent === "string";
        });
        if (update.docChanged && changedByUser && !readonly) {
          onChange(update.state.doc.toString());
        }
      }),
    ];
    const languageExtension =
      language === "yaml"
        ? yaml()
        : language === "javascript"
          ? javascript()
          : language === "typescript"
            ? javascript({ typescript: true })
            : language === "css"
              ? css()
              : language === "html"
                ? html()
                : language === "xml"
                  ? xml()
                  : language === "markdown"
                    ? markdown()
                    : language === "python"
                      ? python()
                      : language === "sql"
                        ? sql()
                        : language === "shell"
                          ? StreamLanguage.define(shell)
                          : language === "powershell"
                            ? StreamLanguage.define(powerShell)
                        : null;
    if (languageExtension) {
      extensions.splice(2, 0, languageExtension);
    }

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
  }, [readonly, minHeight, height, language]);

  useEffect(() => {
    if (viewRef.current && value !== viewRef.current.state.doc.toString()) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="code-editor" style={{ minHeight, height }} />;
}
