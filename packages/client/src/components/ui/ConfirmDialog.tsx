import { X } from "lucide-react";
import { useEffect, useId } from "react";
import { Button } from "./Button";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = "CONFIRM",
  cancelText = "CANCEL",
  onConfirm,
  onCancel,
  variant = "danger",
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const backdropStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.5)",
    cursor: "pointer",
  };

  const dialogStyle: React.CSSProperties = {
    position: "relative",
    background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)",
    padding: "24px",
    width: "100%",
    maxWidth: "28rem",
    zIndex: 10,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: "var(--text-lg)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "8px",
    color: "var(--text-primary)",
  };

  const messageStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-secondary)",
    marginBottom: "24px",
  };

  const buttonGroupStyle: React.CSSProperties = {
    display: "flex",
    gap: "8px",
  };

  const closeStyle: React.CSSProperties = {
    position: "absolute",
    top: "16px",
    right: "16px",
    color: "var(--text-muted)",
    border: "none",
    background: "none",
    cursor: "pointer",
    width: "16px",
    height: "16px",
  };

  return (
    <div style={overlayStyle}>
      <div style={backdropStyle} onClick={onCancel} />
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <button style={closeStyle} onClick={onCancel} aria-label="Close dialog">
          <X size={16} />
        </button>

        <h2 id={titleId} style={titleStyle}>
          {title}
        </h2>
        <p id={descriptionId} style={messageStyle}>
          {message}
        </p>

        <div style={buttonGroupStyle}>
          <Button variant="secondary" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
