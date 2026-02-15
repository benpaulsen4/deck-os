import { cn } from "../../lib/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "icon";
  children?: React.ReactNode;
}

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonProps) {
  const baseStyles = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    textTransform: "uppercase",
    fontWeight: "500",
    cursor: "pointer",
    transition:
      "background 80ms linear, color 80ms linear, border-color 80ms linear",
    fontSize: "var(--text-sm)",
    letterSpacing: "0.06em",
    borderRadius: 0,
    border: "none",
    padding: "8px 16px",
    minHeight: "40px",
    minWidth: "44px",
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: "var(--accent-primary)",
      color: "var(--text-inverse)",
    },
    primaryHover: {
      background: "var(--accent-hover)",
    },
    secondary: {
      background: "transparent",
      border: "1px solid var(--border-active)",
      color: "var(--text-primary)",
    },
    secondaryHover: {
      background: "var(--bg-tertiary)",
      borderColor: "var(--accent-primary)",
    },
    danger: {
      background: "transparent",
      border: "1px solid var(--status-stopped)",
      color: "var(--status-stopped)",
    },
    dangerHover: {
      background: "var(--status-stopped)",
      color: "var(--text-inverse)",
    },
    icon: {
      background: "transparent",
      border: "1px solid var(--border-active)",
      color: "var(--text-primary)",
      padding: 0,
      width: "44px",
      height: "44px",
    },
    iconHover: {
      borderColor: "var(--accent-primary)",
      color: "var(--accent-primary)",
    },
  };

  return (
    <button
      className={cn("deckos-button", className)}
      style={{
        ...baseStyles,
        ...variantStyles[variant],
      }}
      {...props}
    >
      {children}
    </button>
  );
}
