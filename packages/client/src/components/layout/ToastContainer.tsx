import { useToastStore } from "../../stores/toast";
import { Toast } from "../ui/Toast";

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  const containerStyle: React.CSSProperties = {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  };

  return (
    <div style={containerStyle}>
      {toasts.map((toast: { id: string; message: string; type: "success" | "error" | "info" }) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}