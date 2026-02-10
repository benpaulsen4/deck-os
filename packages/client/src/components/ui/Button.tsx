import { cn } from "../../lib/cn";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "icon";
  children?: React.ReactNode;
}

export function Button({ variant = "primary", className, children, ...props }: ButtonProps) {
  const baseStyles = {
    textTransform: "uppercase",
    fontWeight: "500",
    cursor: "pointer",
    transition: "all 80ms linear",
    fontSize: "var(--text-sm)",
    letterSpacing: "0.06em",
    borderRadius: 0,
    border: "none",
    padding: "8px 16px",
  };
  
  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: "var(--accent-primary)",
      color: "var(--text-inverse)",
    },
    secondary: {
      background: "transparent",
      border: "1px solid var(--border-active)",
      color: "var(--text-primary)",
    },
    danger: {
      background: "transparent",
      border: "1px solid var(--status-stopped)",
      color: "var(--status-stopped)",
    },
    icon: {
      background: "transparent",
      border: "1px solid var(--border-active)",
      color: "var(--text-primary)",
      padding: 0,
      width: "32px",
      height: "32px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
  };

  const inlineStyles = {
    ...baseStyles,
    ...variantStyles[variant],
  };

  return (
    <button
      className={cn("deckos-button", className)}
      style={inlineStyles}
      {...props}
    />
  );
}