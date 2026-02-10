import { Check, X, AlertCircle } from "lucide-react";
import { useEffect } from "react";

export type ToastType = "success" | "error" | "info";

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

export function Toast({ message, type = "info", duration = 3000, onClose }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const icons = {
    success: <Check size={16} style={{ color: "var(--status-running)" }} />,
    error: <X size={16} style={{ color: "var(--status-stopped)" }} />,
    info: <AlertCircle size={16} style={{ color: "var(--status-info)" }} />,
  };

  const containerStyle: React.CSSProperties = {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: 50,
  };

  const toastStyle: React.CSSProperties = {
    background: "var(--bg-secondary)",
    borderLeft: "4px solid",
    padding: "12px 16px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    boxShadow: "none",
  };

  const borderColor = {
    success: "var(--status-running)",
    error: "var(--status-stopped)",
    info: "var(--status-info)",
  };

  const messageStyle: React.CSSProperties = {
    fontSize: "var(--text-sm)",
    color: "var(--text-primary)",
  };

  return (
    <div style={containerStyle}>
      <div style={{ ...toastStyle, borderLeftColor: borderColor[type] }}>
        {icons[type]}
        <span style={messageStyle}>{message}</span>
      </div>
    </div>
  );
}