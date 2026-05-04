import { Check, X, AlertCircle } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

export type ToastType = "success" | "error" | "info";

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

export function Toast({ message, type = "info", duration = 3000, onClose }: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef<number>(0);
  const remainingRef = useRef<number>(duration);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    clearTimer();
    startTimeRef.current = Date.now();
    timerRef.current = setTimeout(() => onCloseRef.current(), remainingRef.current);
  }, [clearTimer]);

  useEffect(() => {
    remainingRef.current = duration;
    startTimer();
    return clearTimer;
  }, [clearTimer, duration, startTimer]);

  const handleMouseEnter = useCallback(() => {
    const elapsed = Date.now() - startTimeRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    clearTimer();
  }, [clearTimer]);

  const handleMouseLeave = useCallback(() => {
    if (remainingRef.current <= 0) {
      onCloseRef.current();
      return;
    }
    startTimer();
  }, [startTimer]);

  const icons = {
    success: <Check size={16} style={{ color: "var(--status-running)" }} />,
    error: <X size={16} style={{ color: "var(--status-stopped)" }} />,
    info: <AlertCircle size={16} style={{ color: "var(--status-info)" }} />,
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
    <div
      style={{ ...toastStyle, borderLeftColor: borderColor[type] }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {icons[type]}
      <span style={messageStyle}>{message}</span>
    </div>
  );
}
