import { useId } from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className, ...props }: InputProps) {
  const generatedId = useId();
  const inputId = props.id ?? generatedId;
  const labelStyle = {
    display: "block",
    marginBottom: "4px",
    fontSize: "var(--text-xs)",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
  };

  const inputStyle = {
    width: "100%",
    background: "var(--bg-input)",
    border: "1px solid var(--border-primary)",
    color: "var(--text-primary)",
    padding: "8px 12px",
    fontSize: "var(--text-base)",
    fontFamily: "'JetBrains Mono', monospace",
    outline: "none",
    minHeight: "40px",
    cursor: "text",
  };

  return (
    <div style={{ marginBottom: "var(--space-1)" }}>
      {label && (
        <label htmlFor={inputId} style={labelStyle}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={className}
        style={inputStyle}
        onMouseEnter={(e) => {
          if (document.activeElement !== e.currentTarget) {
            e.currentTarget.style.borderColor = "var(--border-active)";
          }
        }}
        onMouseLeave={(e) => {
          if (document.activeElement !== e.currentTarget) {
            e.currentTarget.style.borderColor = "var(--border-primary)";
          }
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent-primary)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border-primary)";
        }}
        {...props}
      />
    </div>
  );
}
